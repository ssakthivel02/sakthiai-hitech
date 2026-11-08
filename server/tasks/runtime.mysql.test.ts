import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Request } from "express";
import { createTestDatabase, skipMysqlSuite, type TestDatabase } from "../testing/mysqlTestDb";
import { buildGatewayFromEnv } from "../gateway";
import { MysqlTaskStore, TaskFatalError, TaskRetryableError, TaskWorkerRuntime, createChatAnswerHandler, CHAT_ANSWER_TASK, type RuntimeConfig, type TaskHandler } from "./index";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const cfg = (extra: Partial<RuntimeConfig> = {}): RuntimeConfig => ({ enabled: true, concurrency: 2, pollMs: 40, leaseMs: 5000, shutdownGraceMs: 500, ...extra });
const until = async (fn: () => Promise<boolean>, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(30); } return false; };
let ws = 5000; const nextWs = () => (ws += 1);

describe.skipIf(skipMysqlSuite())("durable task worker runtime on real SQL", { timeout: 30_000 }, () => {
  let database: TestDatabase; let store: MysqlTaskStore;
  const getDb = async () => database.db;
  const rows = async <T = Record<string, any>>(q: ReturnType<typeof sql>) => ((await database.db.execute(q)) as unknown as [T[]])[0];
  const runtime = (handlers: Record<string, TaskHandler<any, any>>, extra: Partial<RuntimeConfig> = {}, gateway?: any) => new TaskWorkerRuntime({ store, handlers, gateway, config: cfg(extra), backoffBaseMs: 30, backoffMaxMs: 60 });
  const state = async (w: number, id: string) => (await store.get(w, id))!;
  const running: TaskWorkerRuntime[] = [];
  const track = (r: TaskWorkerRuntime) => { running.push(r); return r; };

  beforeAll(async () => { database = await createTestDatabase(); store = new MysqlTaskStore(getDb); });
  afterAll(async () => { await Promise.all(running.map(r => r.stop(100))); await database?.close(); });

  it("enqueue -> claim -> checkpoint -> complete through the runtime, with status counters", async () => {
    const w = nextWs();
    const { task } = await store.create({ workspaceId: w, type: "rt.echo", input: { v: 1 } });
    const rt = track(runtime({ "rt.echo": async ctx => { await ctx.saveCheckpoint({ s: 1 }, { percent: 50 }); return { ok: true }; } }));
    rt.start();
    expect(await until(async () => (await state(w, task.id)).state === "SUCCEEDED")).toBe(true);
    expect(await state(w, task.id)).toMatchObject({ result: { ok: true }, checkpointSeq: 1, attempt: 1 });
    expect(rt.status()).toMatchObject({ state: "running", enabled: true, healthy: true }); expect(rt.status().processed).toBeGreaterThanOrEqual(1);
    await rt.stop(500);
  });

  it("bounded concurrency: never more than N handlers run at once", async () => {
    const w = nextWs(); let live = 0, peak = 0;
    for (let i = 0; i < 8; i++) await store.create({ workspaceId: w, type: "rt.conc", input: { i } });
    const rt = track(runtime({ "rt.conc": async () => { live++; peak = Math.max(peak, live); await sleep(80); live--; return 1; } }, { concurrency: 3 }));
    rt.start();
    expect(await until(async () => (await store.list(w, { state: "SUCCEEDED" })).length === 8)).toBe(true);
    expect(peak).toBeLessThanOrEqual(3); expect(peak).toBeGreaterThanOrEqual(2);
    await rt.stop(500);
  });

  it("two runtimes racing over many tasks: every task has exactly ONE effective execution", async () => {
    const w = nextWs(); const N = 24; const ran = new Map<string, number>();
    for (let i = 0; i < N; i++) await store.create({ workspaceId: w, type: "rt.race", input: { i } });
    const handler: TaskHandler = async ctx => { await ctx.effect("side", async () => { ran.set(ctx.task.id, (ran.get(ctx.task.id) ?? 0) + 1); return true; }); await sleep(10); return "done"; };
    const a = track(runtime({ "rt.race": handler })); const b = track(runtime({ "rt.race": handler }));
    a.start(); b.start();
    expect(await until(async () => (await store.list(w, { state: "SUCCEEDED", limit: 200 })).length === N)).toBe(true);
    expect(ran.size).toBe(N); expect([...ran.values()].every(n => n === 1)).toBe(true);
    const attempts = await rows<{ attempt: number }>(sql`SELECT attempt FROM durableTasks WHERE workspaceId = ${w}`);
    expect(attempts.every(r => Number(r.attempt) === 1)).toBe(true);
    await Promise.all([a.stop(500), b.stop(500)]);
  });

  it("crash -> lease expiry -> another runtime reclaims and resumes from the checkpoint (completed effects are not repeated)", async () => {
    const w = nextWs(); let effectRuns = 0; let sawCheckpoint: any = "unset"; let release!: () => void; const hang = new Promise<void>(r => (release = r));
    const { task } = await store.create({ workspaceId: w, type: "rt.crash", input: {} });
    const first = track(runtime({ "rt.crash": async ctx => { await ctx.effect("e1", async () => { effectRuns++; return 1; }); await ctx.saveCheckpoint({ step: "after-e1" }); await hang; return "never" } }, { concurrency: 1, leaseMs: 400 }));
    first.start();
    expect(await until(async () => (await state(w, task.id)).checkpointSeq === 1)).toBe(true);
    const stopped = await first.stop(0); // zero grace: handler is mid-flight -> abandoned
    expect(stopped).toMatchObject({ drained: false, abandonedInFlight: 1 });
    const second = track(runtime({ "rt.crash": async ctx => { sawCheckpoint = ctx.checkpoint; await ctx.effect("e1", async () => { effectRuns++; return 1; }); return "resumed"; } }, { concurrency: 1, leaseMs: 400 }));
    second.start();
    expect(await until(async () => (await state(w, task.id)).state === "SUCCEEDED", 10000)).toBe(true);
    expect(sawCheckpoint).toEqual({ step: "after-e1" }); expect(effectRuns).toBe(1);
    expect(await state(w, task.id)).toMatchObject({ result: "resumed", attempt: 2 });
    release(); await second.stop(500);
  });

  it("cancel: no further effect after cancellation is observed", async () => {
    const w = nextWs(); const effects: string[] = [];
    const { task } = await store.create({ workspaceId: w, type: "rt.cancel", input: {} });
    const rt = track(runtime({ "rt.cancel": async ctx => { await ctx.effect("one", async () => { effects.push("one"); return 1; }); await ctx.saveCheckpoint({}); for (let i = 0; i < 100; i++) { await sleep(30); ctx.throwIfCancelled(); } await ctx.effect("two", async () => { effects.push("two"); return 2; }); return "x"; } }, { leaseMs: 600 }));
    rt.start();
    expect(await until(async () => (await state(w, task.id)).checkpointSeq === 1)).toBe(true);
    await store.cancel(w, task.id);
    expect(await until(async () => (await state(w, task.id)).state === "CANCELLED")).toBe(true);
    await sleep(200); expect(effects).toEqual(["one"]);
    await rt.stop(500);
  });

  it("graceful stop drains an in-flight task and claims nothing new afterwards", async () => {
    const w = nextWs();
    const { task } = await store.create({ workspaceId: w, type: "rt.drain", input: {} });
    let started = false;
    const rt = track(runtime({ "rt.drain": async () => { started = true; await sleep(250); return "drained"; } }, { concurrency: 1 }));
    rt.start(); expect(await until(async () => started)).toBe(true);
    expect(await rt.stop(3000)).toEqual({ drained: true, abandonedInFlight: 0 });
    expect(await state(w, task.id)).toMatchObject({ state: "SUCCEEDED", result: "drained" });
    const later = await store.create({ workspaceId: w, type: "rt.drain", input: { late: true } });
    await sleep(200); expect((await state(w, later.task.id)).state).toBe("QUEUED");
    expect(rt.status().state).toBe("stopped");
  });

  it("a handler that throws / a store outage never crashes the process; the runtime recovers and processes the task", async () => {
    const w = nextWs(); const { task } = await store.create({ workspaceId: w, type: "rt.flaky", input: {} });
    let outage = true; const flaky: any = new Proxy(store, { get(t, p, r) { if (p === "claim") return (...a: any[]) => { if (outage) throw new Error("connection lost"); return (t as any).claim(...a); }; return Reflect.get(t, p, r); } });
    const rt = track(new TaskWorkerRuntime({ store: flaky, handlers: { "rt.flaky": async () => "ok" }, config: cfg({ concurrency: 1, pollMs: 40 }) }));
    rt.start(); await sleep(250);
    expect(rt.status().consecutiveErrors).toBeGreaterThan(0); expect(rt.status().lastError).toBe("connection lost");
    outage = false;
    expect(await until(async () => (await state(w, task.id)).state === "SUCCEEDED", 10000)).toBe(true);
    expect(await until(async () => rt.status().consecutiveErrors === 0)).toBe(true); expect(rt.status().healthy).toBe(true);
    await rt.stop(500);
  });

  describe("chat.answer task", () => {
    const evidence = (id: number, content: string) => ({ id, documentId: 1, filename: "temples.txt", mimeType: "text/plain", page: 1, section: null, paragraph: 1, sourceStart: 0, sourceEnd: content.length, content, retrievalMethod: "lexical", score: 1 } as any);
    let userA: number, userB: number, wsA: number, wsB: number, convA: number;
    const mkConv = async (workspaceId: number, userId: number) => { await database.db.execute(sql`INSERT INTO conversations (workspaceId, userId, title, language) VALUES (${workspaceId}, ${userId}, 'c', 'en')`); const [r] = await rows<{ id: number }>(sql`SELECT MAX(id) id FROM conversations`); return Number(r.id); };
    const msgs = (c: number) => rows<{ role: string; content: string; citationsJson: string | null }>(sql`SELECT role, content, citationsJson FROM messages WHERE conversationId = ${c} ORDER BY id`);
    const gw = async (env: Record<string, string>, reply: string) => {
      const calls = { n: 0 };
      const gateway = buildGatewayFromEnv(env, { log: () => undefined, adapterFactory: binding => ({ providerId: binding.providerId, complete: async () => { calls.n += 1; return { content: reply, finishReason: "stop", usage: { totalTokens: 15 }, attempts: 1 }; } }) }, getDb);
      return { gateway, calls };
    };
    beforeAll(async () => {
      await database.db.execute(sql`INSERT INTO users (openId, name, email, loginMethod) VALUES ('rt-a','A','a@x.test','t'),('rt-b','B','b@x.test','t')`);
      const us = await rows<{ id: number }>(sql`SELECT id FROM users WHERE openId IN ('rt-a','rt-b') ORDER BY openId`);
      userA = Number(us[0].id); userB = Number(us[1].id); wsA = nextWs(); wsB = nextWs();
      convA = await mkConv(wsA, userA);
    });

    const run = async (handler: TaskHandler, workspaceId: number, input: any, gateway?: any, maxAttempts = 3) => {
      const { task } = await store.create({ workspaceId, type: CHAT_ANSWER_TASK, input, maxAttempts });
      const rt = track(new TaskWorkerRuntime({ store, handlers: { [CHAT_ANSWER_TASK]: handler }, gateway, config: cfg({ concurrency: 1 }), backoffBaseMs: 20, backoffMaxMs: 40 }));
      rt.start();
      await until(async () => ["SUCCEEDED", "FAILED", "CANCELLED"].includes((await state(workspaceId, task.id)).state), 10000);
      await rt.stop(500);
      return state(workspaceId, task.id);
    };

    it("grounded answer persists question + cited answer exactly once", async () => {
      const { gateway } = await gw({ LOCAL_LLM_API_URL: "http://local.rt.invalid", LOCAL_LLM_MODEL: "m" }, "It opens at 6am. [1]");
      const h = createChatAnswerHandler({ search: async () => [evidence(7, "The temple opens at 6am.")], db: getDb });
      const t = await run(h, wsA, { conversationId: convA, userId: userA, message: "when does it open", language: "en" }, { invoke: (r: any) => gateway.invoke(r) });
      expect(t.state).toBe("SUCCEEDED"); expect(t.result).toMatchObject({ grounding: "GROUNDED_EVIDENCE" });
      const m = await msgs(convA); expect(m.map(x => x.role)).toEqual(["user", "assistant"]);
      expect(JSON.parse(m[1].citationsJson!)[0]).toMatchObject({ filename: "temples.txt", chunkId: 7 });
    });

    it("no evidence -> INSUFFICIENT_EVIDENCE and the model is never called", async () => {
      const c = await mkConv(wsA, userA); const calls = { n: 0 };
      const t = await run(createChatAnswerHandler({ search: async () => [], db: getDb }), wsA, { conversationId: c, userId: userA, message: "nothing", language: "en" }, { invoke: async () => { calls.n++; throw new Error("no"); } });
      expect(t.result).toMatchObject({ grounding: "INSUFFICIENT_EVIDENCE" }); expect(calls.n).toBe(0);
      expect((await msgs(c)).map(x => x.content)).toEqual(["nothing", "INSUFFICIENT_EVIDENCE"]);
    });

    it("cross-workspace denial: a task in another workspace can neither read nor write a foreign conversation", async () => {
      const c = await mkConv(wsA, userA); const before = (await msgs(c)).length; let searched = 0;
      const h = createChatAnswerHandler({ search: async () => { searched++; return []; }, db: getDb });
      const t = await run(h, wsB, { conversationId: c, userId: userA, message: "leak", language: "en" });
      expect(t).toMatchObject({ state: "FAILED", failureClass: "NON_RETRYABLE" }); expect(searched).toBe(0);
      expect((await msgs(c)).length).toBe(before);
      // same workspace but wrong user is refused as well
      const t2 = await run(h, wsA, { conversationId: c, userId: userB, message: "leak", language: "en" });
      expect(t2.state).toBe("FAILED"); expect((await msgs(c)).length).toBe(before);
    });

    it("budget refusal -> task SUCCEEDED with truthful MODEL_UNAVAILABLE; provider never contacted; not retried", async () => {
      const w = nextWs(); const u = userA; const c = await mkConv(w, u);
      // metered external with no workspace policy row => denied by the gateway (budget_denied): fatal, never retried, provider never contacted
      const { gateway, calls } = await gw({ LLM_API_URL: "https://external.rt.invalid", LLM_MODEL: "m", GATEWAY_ALLOW_EXTERNAL: "true", GATEWAY_ALLOW_METERED: "true", GATEWAY_STATE_STORE: "mysql", GATEWAY_MAX_OUTPUT_TOKENS: "10", GATEWAY_MAX_ATTEMPTS: "1" }, "should not happen");
      const h = createChatAnswerHandler({ search: async () => [evidence(9, "x")], db: getDb });
      const t = await run(h, w, { conversationId: c, userId: u, message: "q", language: "en" }, { invoke: (r: any) => gateway.invoke(r) });
      expect(t.state).toBe("SUCCEEDED"); expect(t.result).toMatchObject({ grounding: "MODEL_UNAVAILABLE" }); expect(t.attempt).toBe(1); expect(calls.n).toBe(0);
    });

    it("transient provider outage is retried with backoff, then answers; exhausted retries end as MODEL_UNAVAILABLE", async () => {
      const c1 = await mkConv(wsA, userA); let n = 0;
      const flaky = { invoke: async () => { n++; if (n < 2) return { status: "failed", reason: "unavailable", attempts: [], latencyMs: 1 }; return { status: "returned", content: "ok [1]", providerId: "p", attempts: [], latencyMs: 1 }; } };
      const h = createChatAnswerHandler({ search: async () => [evidence(3, "x")], db: getDb });
      const t = await run(h, wsA, { conversationId: c1, userId: userA, message: "q", language: "en" }, flaky);
      expect(t.state).toBe("SUCCEEDED"); expect(t.attempt).toBe(2); expect(t.result).toMatchObject({ grounding: "GROUNDED_EVIDENCE" });
      expect((await msgs(c1)).map(x => x.role)).toEqual(["user", "assistant"]); // question not duplicated by the retry
      const c2 = await mkConv(wsA, userA);
      const down = { invoke: async () => ({ status: "failed", reason: "unavailable", attempts: [], latencyMs: 1 }) };
      const t2 = await run(h, wsA, { conversationId: c2, userId: userA, message: "q", language: "en" }, down, 2);
      expect(t2.state).toBe("SUCCEEDED"); expect(t2.attempt).toBe(2); expect(t2.result).toMatchObject({ grounding: "MODEL_UNAVAILABLE" });
    });

    it("chat.sendAsync end to end: enqueue via tRPC, worker answers, foreign workspace and disabled flag are refused", async () => {
      const prev = { ...process.env };
      Object.assign(process.env, { DATABASE_URL: database.url, DATABASE_EXPECTED_NAME: database.name, JWT_SECRET: "rt-test-secret-not-real-0123456789", VITE_APP_ID: "rt", TASK_WORKER_ENABLED: "false" });
      const routers = await import("../routers"); const dbm = await import("../db");
      const gm = await import("../gateway");
      const userRows = await rows<any>(sql`SELECT * FROM users WHERE openId IN ('rt-a','rt-b') ORDER BY openId`);
      const [ua, ub] = userRows;
      const wA = (await dbm.ensureWorkspace(ua)).id; const wB = (await dbm.ensureWorkspace(ub)).id;
      const caller = (user: any) => routers.appRouter.createCaller({ user, req: { protocol: "https", headers: {} } as Request, res: { headersSent: false, setHeader: () => undefined, clearCookie: () => undefined } as any, requestId: "rt" } as any);
      await expect(caller(ua).chat.sendAsync({ workspaceId: wA, message: "hello there" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
      process.env.TASK_WORKER_ENABLED = "true";
      await expect(caller(ub).chat.sendAsync({ workspaceId: wA, message: "hello there" })).rejects.toBeTruthy();
      const foreignConv = await mkConv(wB, ub.id);
      await expect(caller(ua).chat.sendAsync({ workspaceId: wA, conversationId: foreignConv, message: "hello there" })).rejects.toMatchObject({ code: "FORBIDDEN" });
      const stubCfg = gm.loadGatewayConfig({ LOCAL_LLM_API_URL: "http://local.rt.invalid", LOCAL_LLM_MODEL: "m" });
      gm.setProviderGatewayForTests(gm.createProviderGateway(stubCfg, { log: () => undefined, adapterFactory: (b: any) => ({ providerId: b.providerId, complete: async () => ({ content: "answer [1]", usage: { inputTokens: 1, outputTokens: 1 } } as any) }) } as any));
      const [docRow] = await (async () => { await database.db.execute(sql`INSERT INTO documents (workspaceId, filename, mimeType, extractedText, contentHash) VALUES (${wA}, 'kb.txt', 'text/plain', 'Murugan temple opens at six', 'h1')`); return rows<{ id: number }>(sql`SELECT MAX(id) id FROM documents`); })();
      const { searchTextFor } = await import("../retrievalStore");
      await database.db.execute(sql`INSERT INTO documentChunks (documentId, workspaceId, chunkIndex, page, content, searchText) VALUES (${Number(docRow.id)}, ${wA}, 0, 1, 'Murugan temple opens at six', ${searchTextFor("Murugan temple opens at six")})`);
      const { taskId, conversationId } = await caller(ua).chat.sendAsync({ workspaceId: wA, message: "Murugan temple opens when", idempotencyKey: "idem-key-0001" });
      const again = await caller(ua).chat.sendAsync({ workspaceId: wA, message: "Murugan temple opens when", conversationId, idempotencyKey: "idem-key-0001" }).catch(e => e);
      expect(again).toBeTruthy();
      const shared = await import("./shared");
      const rt = shared.getTaskRuntime(); rt.start();
      expect(await until(async () => (await caller(ua).tasks.get({ workspaceId: wA, taskId })).state === "SUCCEEDED", 10000)).toBe(true);
      await expect(caller(ub).tasks.get({ workspaceId: wA, taskId })).rejects.toBeTruthy();
      const view = await caller(ua).tasks.get({ workspaceId: wA, taskId });
      expect(view.result).toMatchObject({ grounding: "GROUNDED_EVIDENCE", answer: "answer [1]" });
      expect((await msgs(conversationId)).map(m => m.role)).toEqual(["user", "assistant"]);
      await rt.stop(500); gm.setProviderGatewayForTests(null); shared.resetTaskRuntimeForTests();
      process.env.TASK_WORKER_ENABLED = prev.TASK_WORKER_ENABLED ?? ""; if (prev.TASK_WORKER_ENABLED === undefined) delete process.env.TASK_WORKER_ENABLED;
    });
  });
});
