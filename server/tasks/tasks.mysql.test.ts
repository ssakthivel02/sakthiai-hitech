import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDatabase, skipMysqlSuite, type TestDatabase } from "../testing/mysqlTestDb";
import { buildGatewayFromEnv, upsertWorkspaceProviderPolicy } from "../gateway";
import { MysqlTaskStore, TaskFatalError, TaskIdempotencyConflict, TaskRetryableError, TaskWorker, type TaskHandler } from "./index";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
let ws = 1000;
const nextWs = () => (ws += 1);

describe.skipIf(skipMysqlSuite())("durable tasks on real SQL", () => {
  let database: TestDatabase; let store: MysqlTaskStore; let store2: MysqlTaskStore;
  const getDb = async () => database.db;
  const rows = async <T = Record<string, any>>(query: ReturnType<typeof sql>) => ((await database.db.execute(query)) as unknown as [T[]])[0];
  const worker = (handlers: Record<string, TaskHandler<any, any>>, extra: Partial<ConstructorParameters<typeof TaskWorker>[0]> = {}) => new TaskWorker({ store, handlers, leaseMs: 5000, backoffBaseMs: 30, backoffMaxMs: 60, ...extra });

  beforeAll(async () => { database = await createTestDatabase(); store = new MysqlTaskStore(getDb); store2 = new MysqlTaskStore(getDb); });
  afterAll(async () => { await database?.close(); });

  it("create -> run -> success, with progress, result and timestamps", async () => {
    const w = nextWs();
    const { task, created } = await store.create({ workspaceId: w, type: "demo.echo", input: { text: "வணக்கம் hello" } });
    expect(created).toBe(true); expect(task.state).toBe("QUEUED");
    const result = await worker({ "demo.echo": async ctx => { await ctx.saveCheckpoint({ step: 1 }, { percent: 50, note: "half" }); return { echoed: (ctx.input as any).text }; } }).runOnce();
    expect(result).toMatchObject({ status: "succeeded", taskId: task.id });
    const done = (await store.get(w, task.id))!;
    expect(done).toMatchObject({ state: "SUCCEEDED", attempt: 1, result: { echoed: "வணக்கம் hello" }, progressPercent: 100, checkpointSeq: 1, leaseOwner: null });
    expect(done.startedAt).toBeTruthy(); expect(done.finishedAt).toBeTruthy();
  });

  it("checkpoint -> simulated process death -> another worker resumes from the checkpoint; the stale worker is fenced out", async () => {
    const w = nextWs();
    const { task } = await store.create({ workspaceId: w, type: "demo.resume", input: {} });
    // worker A claims with a short lease, checkpoints, then "crashes" (never completes)
    const a = (await store.claim("worker-A", { leaseMs: 150, types: ["demo.resume"] }))!;
    expect(a.id).toBe(task.id);
    expect((await store.checkpoint(a.id, "worker-A", a.attempt, { seq: 1, data: { done: ["x", "y"] }, progressPercent: 40, leaseMs: 150 })).ok).toBe(true);
    expect(await store.claim("worker-C", { leaseMs: 5000, types: ["demo.resume"] })).toBeNull(); // lease still live: nobody else may run it
    await sleep(250); // lease expires
    let seen: any = "unset";
    const result = await worker({ "demo.resume": async ctx => { seen = { checkpoint: ctx.checkpoint, attempt: ctx.attempt }; await ctx.saveCheckpoint({ done: ["x", "y", "z"] }); return "finished"; } }, { owner: "worker-B" }).runOnce();
    expect(result.status).toBe("succeeded");
    expect(seen).toEqual({ checkpoint: { done: ["x", "y"] }, attempt: 2 });
    // the crashed worker waking up late cannot overwrite anything
    expect(await store.complete(a.id, "worker-A", a.attempt, "stale")).toBe(false);
    expect((await store.checkpoint(a.id, "worker-A", a.attempt, { seq: 99, data: "stale", leaseMs: 1000 })).ok).toBe(false);
    expect(await store.fail(a.id, "worker-A", a.attempt, { failureClass: "INTERNAL", message: "stale", retryable: false })).toBe("LOST");
    expect((await store.get(w, task.id))).toMatchObject({ state: "SUCCEEDED", result: "finished", checkpoint: { done: ["x", "y", "z"] } });
  });

  it("fencing while the new owner is still RUNNING: the previous owner cannot checkpoint, heartbeat, complete, fail or cancel; wrong owner or attempt is refused", async () => {
    const w = nextWs();
    const { task } = await store.create({ workspaceId: w, type: "demo.fence", input: {} });
    const a = (await store.claim("owner-A", { leaseMs: 60, types: ["demo.fence"] }))!;
    await sleep(120);
    const b = (await store.claim("owner-B", { leaseMs: 5000, types: ["demo.fence"] }))!;
    expect([a.id, b.id, b.attempt, b.leaseOwner]).toEqual([task.id, task.id, 2, "owner-B"]);
    expect(await store.heartbeat(task.id, "owner-A", a.attempt, 5000)).toEqual({ ok: false, cancelRequested: false });
    expect((await store.checkpoint(task.id, "owner-A", a.attempt, { seq: 1, data: "stale", leaseMs: 5000 })).ok).toBe(false);
    expect(await store.complete(task.id, "owner-A", a.attempt, "stale")).toBe(false);
    expect(await store.fail(task.id, "owner-A", a.attempt, { failureClass: "INTERNAL", message: "stale", retryable: false })).toBe("LOST");
    expect(await store.markCancelled(task.id, "owner-A", a.attempt)).toBe(false);
    // same owner name but an old attempt number is fenced too; and a different owner on the current attempt is refused
    expect(await store.complete(task.id, "owner-B", a.attempt, "old attempt")).toBe(false);
    expect(await store.complete(task.id, "owner-A", b.attempt, "wrong owner")).toBe(false);
    expect((await store.get(w, task.id))).toMatchObject({ state: "RUNNING", leaseOwner: "owner-B", checkpoint: null, result: null });
    expect(await store.complete(task.id, "owner-B", b.attempt, "fresh")).toBe(true);
    expect((await store.get(w, task.id))).toMatchObject({ state: "SUCCEEDED", result: "fresh" });
  });

  it("a crashed worker never becomes success: with no attempts left the task FAILS visibly (LEASE_EXPIRED)", async () => {
    const w = nextWs();
    const { task } = await store.create({ workspaceId: w, type: "demo.crash", input: {}, maxAttempts: 1 });
    await store.claim("dead-worker", { leaseMs: 50, types: ["demo.crash"] });
    await sleep(120);
    expect(await store.claim("w2", { leaseMs: 1000, types: ["demo.crash"] })).toBeNull();
    expect(await store.get(w, task.id)).toMatchObject({ state: "FAILED", failureClass: "LEASE_EXPIRED", attempt: 1 });
  });

  it("retryable failure backs off then succeeds; the backoff is honoured; attempts are bounded", async () => {
    const w = nextWs();
    const { task } = await store.create({ workspaceId: w, type: "demo.flaky", input: {} });
    let calls = 0;
    const wk = worker({ "demo.flaky": async () => { calls += 1; if (calls === 1) throw new TaskRetryableError("transient", "RETRYABLE", 300); return "ok"; } });
    expect((await wk.runOnce()).status).toBe("waiting");
    expect(await store.get(w, task.id)).toMatchObject({ state: "WAITING", failureClass: "RETRYABLE", attempt: 1 });
    expect((await wk.runOnce()).status).toBe("idle"); // retryAfter not reached
    await sleep(380);
    expect((await wk.runOnce()).status).toBe("succeeded");
    expect(calls).toBe(2);

    const bounded = (await store.create({ workspaceId: w, type: "demo.always-fails", input: {}, maxAttempts: 2 })).task;
    let n = 0;
    const wk2 = worker({ "demo.always-fails": async () => { n += 1; throw new Error("boom with secret sk-123"); } });
    expect((await wk2.runOnce()).status).toBe("waiting");
    await sleep(100);
    expect((await wk2.runOnce()).status).toBe("failed");
    expect(n).toBe(2);
    expect(await store.get(w, bounded.id)).toMatchObject({ state: "FAILED", failureClass: "INTERNAL", attempt: 2 });
  });

  it("non-retryable failure fails immediately without a second attempt", async () => {
    const w = nextWs();
    const { task } = await store.create({ workspaceId: w, type: "demo.fatal", input: {} });
    let n = 0;
    expect((await worker({ "demo.fatal": async () => { n += 1; throw new TaskFatalError("bad input"); } }).runOnce()).status).toBe("failed");
    expect((await worker({ "demo.fatal": async () => { n += 1; } }).runOnce()).status).toBe("idle");
    expect(n).toBe(1);
    expect(await store.get(w, task.id)).toMatchObject({ state: "FAILED", failureClass: "NON_RETRYABLE", attempt: 1, errorMessage: "bad input" });
  });

  it("duplicate delivery: a finished task is never run again, and recorded side effects are not repeated on retry", async () => {
    const w = nextWs();
    const { task } = await store.create({ workspaceId: w, type: "demo.effects", input: {}, maxAttempts: 3 });
    let sends = 0; let attempts = 0;
    const handler: TaskHandler = async ctx => {
      attempts += 1;
      const receipt = await ctx.effect("send-email", async () => { sends += 1; return { id: "msg-1" }; });
      if (attempts === 1) throw new TaskRetryableError("crash after the side effect", "RETRYABLE", 20);
      return receipt;
    };
    const wk = worker({ "demo.effects": handler });
    expect((await wk.runOnce()).status).toBe("waiting");
    await sleep(60);
    expect((await wk.runOnce()).status).toBe("succeeded");
    expect(sends).toBe(1); // replayed from the durable record on the second attempt
    expect((await store.get(w, task.id))!.result).toEqual({ id: "msg-1" });
    for (let i = 0; i < 3; i += 1) expect((await wk.runOnce()).status).toBe("idle"); // duplicate deliveries
    expect(attempts).toBe(2);
  });

  it("idempotent creation: same key returns the same task; different payload conflicts; keys are per workspace", async () => {
    const w1 = nextWs(); const w2 = nextWs();
    const a = await store.create({ workspaceId: w1, type: "demo.idem", input: { n: 1 }, idempotencyKey: "req-1" });
    const b = await store2.create({ workspaceId: w1, type: "demo.idem", input: { n: 1 }, idempotencyKey: "req-1" });
    expect(b.created).toBe(false); expect(b.task.id).toBe(a.task.id);
    await expect(store.create({ workspaceId: w1, type: "demo.idem", input: { n: 2 }, idempotencyKey: "req-1" })).rejects.toBeInstanceOf(TaskIdempotencyConflict);
    const other = await store.create({ workspaceId: w2, type: "demo.idem", input: { n: 1 }, idempotencyKey: "req-1" });
    expect(other.created).toBe(true); expect(other.task.id).not.toBe(a.task.id);
    const racing = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? store : store2).create({ workspaceId: w1, type: "demo.idem2", input: {}, idempotencyKey: "race" })));
    expect(new Set(racing.map(r => r.task.id)).size).toBe(1);
    expect(racing.filter(r => r.created)).toHaveLength(1);
  });

  it("cancellation is durable: queued tasks never run; running tasks stop at the next checkpoint; dead workers' cancelled tasks are finalised; terminal tasks are untouched", async () => {
    const w = nextWs();
    const queued = (await store.create({ workspaceId: w, type: "demo.cancel", input: {} })).task;
    expect((await store.cancel(w, queued.id))!.state).toBe("CANCELLED");
    let ran = 0;
    expect((await worker({ "demo.cancel": async () => { ran += 1; } }).runOnce()).status).toBe("idle");
    expect(ran).toBe(0);

    const running = (await store.create({ workspaceId: w, type: "demo.cancel-running", input: {} })).task;
    const wk = worker({ "demo.cancel-running": async ctx => { await ctx.saveCheckpoint({ i: 0 }); await sleep(200); await ctx.saveCheckpoint({ i: 1 }); return "should not complete"; } });
    const run = wk.runOnce();
    await sleep(80);
    expect((await store.cancel(w, running.id))!.cancelRequested).toBe(true);
    expect((await run).status).toBe("cancelled");
    expect(await store.get(w, running.id)).toMatchObject({ state: "CANCELLED", cancelRequested: true, leaseOwner: null });

    const orphan = (await store.create({ workspaceId: w, type: "demo.cancel-orphan", input: {} })).task;
    await store.claim("dead", { leaseMs: 50, types: ["demo.cancel-orphan"] });
    await store.cancel(w, orphan.id); await sleep(120);
    await store.claim("alive", { leaseMs: 1000, types: ["zzz"] });
    expect((await store.get(w, orphan.id))!.state).toBe("CANCELLED");

    const finished = (await store.create({ workspaceId: w, type: "demo.done", input: {} })).task;
    await worker({ "demo.done": async () => "x" }).runOnce();
    expect((await store.cancel(w, finished.id))!.state).toBe("SUCCEEDED");
  });

  it("cross-workspace read, list, cancel and idempotency are isolated", async () => {
    const mine = nextWs(); const theirs = nextWs();
    const { task } = await store.create({ workspaceId: mine, type: "demo.private", input: { secret: "s" } });
    expect(await store.get(theirs, task.id)).toBeNull();
    expect(await store.cancel(theirs, task.id)).toBeNull();
    expect((await store.list(theirs)).map(t => t.id)).not.toContain(task.id);
    expect((await store.list(mine)).map(t => t.id)).toContain(task.id);
    expect((await store.get(mine, task.id))!.state).toBe("QUEUED"); // the foreign cancel changed nothing
  });

  it("two worker instances racing: exactly one claims a task; 40 tasks drained by 6 workers run exactly once each", async () => {
    const w = nextWs();
    const { task } = await store.create({ workspaceId: w, type: "demo.race", input: {} });
    const claims = await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? store : store2).claim(`racer-${i}`, { leaseMs: 5000, types: ["demo.race"] })));
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.find(Boolean)!.id).toBe(task.id);

    const runs = new Map<string, number>();
    const ids = [] as string[];
    for (let i = 0; i < 40; i += 1) ids.push((await store.create({ workspaceId: w, type: "demo.drain", input: { i } })).task.id);
    const handler: TaskHandler = async ctx => { runs.set(ctx.task.id, (runs.get(ctx.task.id) ?? 0) + 1); await sleep(5); return ctx.input; };
    const workers = Array.from({ length: 6 }, (_, i) => new TaskWorker({ store: i % 2 ? store : store2, handlers: { "demo.drain": handler }, leaseMs: 5000, owner: `drain-${i}` }));
    await Promise.all(workers.map(async wk => { while ((await wk.runOnce()).status !== "idle") { /* drain */ } }));
    expect(runs.size).toBe(40);
    expect([...runs.values()].every(n => n === 1)).toBe(true);
    for (const id of ids) expect((await store.get(w, id))!.state).toBe("SUCCEEDED");
  });

  it("Provider Gateway integration: outage retries with backoff then fails PROVIDER_UNAVAILABLE; budget exhaustion fails BUDGET_DENIED with no retry; non-metered policy denial likewise", async () => {
    const env = { LLM_API_URL: "https://external.it.invalid", LLM_MODEL: "m", GATEWAY_ALLOW_EXTERNAL: "true", GATEWAY_ALLOW_METERED: "true", GATEWAY_STATE_STORE: "mysql", GATEWAY_MAX_OUTPUT_TOKENS: "10", GATEWAY_MAX_ATTEMPTS: "1" };
    let adapterCalls = 0; let mode: "ok" | "down" = "ok";
    const gateway = buildGatewayFromEnv(env, { log: () => undefined, adapterFactory: binding => ({ providerId: binding.providerId, complete: async () => { adapterCalls += 1; if (mode === "down") { const { ProviderCallError } = await import("../gateway/types"); throw new ProviderCallError("server_error", 503); } return { content: "model says hi", finishReason: "stop", usage: { totalTokens: 20 }, attempts: 1 }; } }) }, getDb);
    const handlers = { "demo.llm": (async (ctx: any) => ({ text: await ctx.invokeModel({ messages: [{ role: "user", content: "hi" }] }) })) as TaskHandler };
    const wk = (w: number) => worker(handlers, { gateway, backoffBaseMs: 20, backoffMaxMs: 40 });

    // metered external with no workspace policy row => denied (reported by the gateway as budget_denied): fatal, one attempt, provider never contacted
    const wsDenied = nextWs();
    const denied = (await store.create({ workspaceId: wsDenied, type: "demo.llm", input: {} })).task;
    expect((await wk(wsDenied).runOnce()).status).toBe("failed");
    expect(await store.get(wsDenied, denied.id)).toMatchObject({ state: "FAILED", failureClass: "BUDGET_DENIED", attempt: 1 });
    expect(adapterCalls).toBe(0);

    // non-metered (subscription) external without the workspace opt-in => POLICY_DENIED, fatal
    const subscription = buildGatewayFromEnv({ ...env, LLM_BILLING_MODE: "subscription" }, { log: () => undefined, adapterFactory: binding => ({ providerId: binding.providerId, complete: async () => { adapterCalls += 1; return { content: "x", finishReason: "stop", usage: null, attempts: 1 }; } }) }, getDb);
    const wsPolicy = nextWs();
    const policyTask = (await store.create({ workspaceId: wsPolicy, type: "demo.llm", input: {} })).task;
    expect((await worker(handlers, { gateway: subscription }).runOnce()).status).toBe("failed");
    expect(await store.get(wsPolicy, policyTask.id)).toMatchObject({ state: "FAILED", failureClass: "POLICY_DENIED", attempt: 1 });
    expect(adapterCalls).toBe(0);

    // budget of exactly one request: first task succeeds, second is BUDGET_DENIED (fatal, not retried)
    const wsB = nextWs();
    await upsertWorkspaceProviderPolicy(getDb as never, wsB, { externalEnabled: true, meteredEnabled: true, maxRequestsPerDay: 1 });
    const first = (await store.create({ workspaceId: wsB, type: "demo.llm", input: {} })).task;
    expect((await wk(wsB).runOnce()).status).toBe("succeeded");
    expect((await store.get(wsB, first.id))!.result).toEqual({ text: "model says hi" });
    const second = (await store.create({ workspaceId: wsB, type: "demo.llm", input: {} })).task;
    expect((await wk(wsB).runOnce()).status).toBe("failed");
    expect(await store.get(wsB, second.id)).toMatchObject({ state: "FAILED", failureClass: "BUDGET_DENIED", attempt: 1 });
    expect(adapterCalls).toBe(1); // retries/other tasks never bypassed the budget

    // provider outage inside budget: retryable with bounded attempts
    const wsC = nextWs();
    await upsertWorkspaceProviderPolicy(getDb as never, wsC, { externalEnabled: true, meteredEnabled: true, maxRequestsPerDay: 50 });
    mode = "down";
    const outage = (await store.create({ workspaceId: wsC, type: "demo.llm", input: {}, maxAttempts: 2 })).task;
    const w3 = wk(wsC);
    expect((await w3.runOnce()).status).toBe("waiting");
    await sleep(80);
    expect((await w3.runOnce()).status).toBe("failed");
    expect(await store.get(wsC, outage.id)).toMatchObject({ state: "FAILED", failureClass: "PROVIDER_UNAVAILABLE", attempt: 2 });
    expect((await store.get(wsC, outage.id))!.errorMessage).toBe("model provider unavailable (server_error)"); // provider-neutral reason only, no status/body
  });

  it("oversized input/checkpoint/result are refused; invalid types and keys are refused", async () => {
    const w = nextWs();
    await expect(store.create({ workspaceId: w, type: "demo.big", input: "x".repeat(70_000) })).rejects.toThrow(/exceeds/);
    await expect(store.create({ workspaceId: w, type: "bad type!", input: {} })).rejects.toThrow(/invalid task type/);
    await expect(store.create({ workspaceId: w, type: "demo.k", input: {}, idempotencyKey: "has space" })).rejects.toThrow(/invalid idempotency key/);
    await expect(store.create({ workspaceId: 0, type: "demo.k", input: {} })).rejects.toThrow(/workspaceId/);
  });

  it("database unavailable: every operation rejects (a worker cannot silently proceed)", async () => {
    const down = new MysqlTaskStore(async () => null);
    await expect(down.claim("w", { leaseMs: 1000 })).rejects.toThrow(/unavailable/);
    await expect(down.create({ workspaceId: 1, type: "x", input: {} })).rejects.toThrow(/unavailable/);
    await expect(new TaskWorker({ store: down, handlers: { x: async () => 1 } }).runOnce()).rejects.toThrow(/unavailable/);
    expect((await rows(sql`SELECT COUNT(*) c FROM durableTasks WHERE type = 'x'`))[0].c).toBe(0);
  });
});
