import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, skipMysqlSuite, type TestDatabase } from "../testing/mysqlTestDb";
import { MysqlTaskStore, TaskRetryableError, TaskWorker } from "../tasks";
import { MysqlSentinelStore } from "./store.mysql";
import { createSentinelInvestigateHandler } from "./handler";
import { FakeTools, goodModel, newRow, WS } from "./testkit";
import { verifyTrace } from "./engine/trace";

// Scripted decisions and synthetic tools, but actual SQL stores and actual TaskWorker retries.
// Faults simulate ambiguous persisted-write acknowledgements, not process termination or a live provider.
describe.skipIf(skipMysqlSuite())("Sentinel durable retry boundaries on real SQL", () => {
  let db: TestDatabase;
  beforeAll(async () => { db = await createTestDatabase(); });
  afterAll(async () => { await db?.close(); });
  it.each(["tool-result", "model-reservation", "reservation-budget", "finalize"] as const)("recovers after persisted %s acknowledgement loss", async boundary => {
    const base = new MysqlSentinelStore(async () => db.db);
    const tasks = new MysqlTaskStore(async () => db.db);
    const tools = new FakeTools();
    const row = newRow({ id: randomUUID() });
    await base.create(row);
    const { task } = await tasks.create({ workspaceId: WS, type: "sentinel.investigate", input: { investigationId: row.id }, maxAttempts: 2 });
    await base.attachTask(WS, row.id, task.id);
    let faulted = false, modelInvocations = 0;
    const store = new Proxy(base, { get(target, prop) {
      const value = Reflect.get(target, prop);
      if (typeof value !== "function") return value;
      return async (...args: any[]) => {
        const out = await value.apply(target, args);
        if (!faulted && ((boundary === "tool-result" && prop === "appendEvents" && args[2].some((e: any) => e.type === "tool_result" && e.payload.status === "OK")) || (boundary === "finalize" && prop === "finalize"))) {
          faulted = true; throw new TaskRetryableError("injected lost tool commit acknowledgement", "INTERNAL", 0);
        }
        return out;
      };
    } });
    const taskStore = new Proxy(tasks, { get(target, prop) {
      const value = Reflect.get(target, prop);
      if (typeof value !== "function") return value;
      return async (...args: any[]) => {
        const out = await value.apply(target, args);
        if ((boundary === "model-reservation" || boundary === "reservation-budget") && prop === "checkpoint" && !faulted && args[3]?.data?.modelCalls === 1) {
          faulted = true; throw new TaskRetryableError("injected lost reservation acknowledgement", "INTERNAL", 0);
        }
        return out;
      };
    } });
    const handler = createSentinelInvestigateHandler({ store, mcp: { callTool: async () => { throw Error("no live connector"); } }, enabled: () => true,
      config: () => ({ policyTimeoutMs: 5000, toolAttemptTimeoutMs: 1000, maxModelCalls: boundary === "reservation-budget" ? 3 : 4, formatRetries: 1, cancelPollMs: 20 }), transportFor: () => tools,
      modelFor: () => { const model = goodModel(); return { ...model, complete: async req => { modelInvocations++; return model.complete(req); } }; } });
    const first = new TaskWorker({ store: taskStore, handlers: { "sentinel.investigate": handler }, owner: "before-restart", backoffBaseMs: 1 });
    expect((await first.runOnce()).status).toBe("waiting");
    expect(faulted).toBe(true);
    const interrupted = await tasks.get(WS, task.id);
    expect(interrupted!.state).toBe("WAITING");
    const second = new TaskWorker({ store: tasks, handlers: { "sentinel.investigate": handler }, owner: "after-restart", backoffBaseMs: 1 });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect((await second.runOnce()).status).toBe("succeeded");
    const done = (await tasks.get(WS, task.id))!;
    expect(done).toMatchObject({ state: "SUCCEEDED", attempt: 2 });
    expect((await base.get(WS, row.id))!).toMatchObject(boundary === "reservation-budget" ? { outcome: "ABSTAIN", verified: false } : { outcome: "DIAGNOSIS", label: "DISK_FULL", verified: true });
    expect(tools.calls.map(c => c.tool)).toEqual(["logs.search", "metrics.query"]);
    expect(modelInvocations).toBe(boundary === "reservation-budget" ? 2 : 3);
    expect(done.checkpoint).toMatchObject({ modelCalls: boundary === "model-reservation" ? 4 : 3 });
    const trace = await base.readEvents(WS, row.id);
    expect(verifyTrace(trace, row.id).ok).toBe(true);
    expect(trace.filter(e => e.type === "final")).toHaveLength(1);
  });
});
