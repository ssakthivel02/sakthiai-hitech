import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDatabase, skipMysqlSuite } from "../testing/mysqlTestDb";
import type { TestDatabase } from "../testing/mysqlTestDb";
import { MysqlSentinelStore } from "./store.mysql";
import { defineStoreContract } from "./store.contract";
import { createSentinelInvestigateHandler } from "./handler";
import { verifyTrace } from "./engine/trace";
import { FakeTools, ID, WS, fakeCtx, goodModel, newRow } from "./testkit";
import { tenantOf } from "./config";

/**
 * Real-SQL integration for the Sentinel store. Runs ONLY against a throwaway database created by server/testing/mysqlTestDb.ts
 * (TEST_DATABASE_URL, loopback, refuses managed hosts). The 0013 PROPOSAL is applied to that throwaway database only; the repository
 * migration journal is untouched.
 *   TEST_DATABASE_URL=mysql://user:pass@127.0.0.1:3306 pnpm vitest run server/sentinel/store.mysql.test.ts
 */
const skip = skipMysqlSuite();
const proposal = () => readFileSync(path.join(process.cwd(), "drizzle/proposals/0014_sentinel_investigations.sql"), "utf8").split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);
const names = ["sentinelAudit", "sentinelEvents", "sentinelInvestigations"];

let shared: TestDatabase | null = null;
const dbOf = async () => {
  if (!shared) { shared = await createTestDatabase(); for (const stmt of proposal()) await shared.pool.promise().query(stmt); }
  return shared;
};
afterAll(async () => { await shared?.close(); });

defineStoreContract("mysql", async () => {
  const db = await dbOf();
  for (const t of names) await db.pool.promise().query(`DELETE FROM \`${t}\``);          // isolate each contract test
  return { store: new MysqlSentinelStore(async () => db.db) };
}, { skip });

describe.skipIf(skip)("MysqlSentinelStore with the real handler", () => {
  let store: MysqlSentinelStore; let db: TestDatabase;
  beforeAll(async () => { db = await dbOf(); store = new MysqlSentinelStore(async () => db.db); });

  const deps = (over = {}) => ({ store, mcp: { callTool: async () => { throw new Error("mcp must not be used"); } }, enabled: () => true,
    config: () => ({ policyTimeoutMs: 5000, toolAttemptTimeoutMs: 2000, maxModelCalls: 24, formatRetries: 1, cancelPollMs: 20 }), ...over });
  const seed = async () => { for (const t of names) await db.pool.promise().query(`DELETE FROM \`${t}\``); const r = await store.create(newRow()); await store.attachTask(r.workspaceId, r.id, "22222222-2222-4222-8222-222222222222"); };

  it("runs a full investigation through the real handler and persists a verifiable trace in SQL", async () => {
    await seed();
    const tools = new FakeTools(); const { ctx } = fakeCtx();
    const out = await createSentinelInvestigateHandler(deps({ transportFor: () => tools, modelFor: () => goodModel() }))(ctx) as { status: string; verified: boolean };
    expect(out.status).toBe("COMPLETED"); expect(out.verified).toBe(true);
    const row = (await store.get(WS, ID))!; const events = await store.readEvents(WS, ID);
    expect(row.status).toBe("COMPLETED"); expect(row.eventCount).toBe(events.length); expect(row.traceHead).toBe(events[events.length - 1]!.hash);
    expect(verifyTrace(events, ID).ok).toBe(true);
    expect(tools.calls.every((c) => c.tenant === tenantOf(WS))).toBe(true);
    const raw = ((await db.db.execute(sql`SELECT COUNT(*) AS n FROM sentinelEvents WHERE investigationId = ${ID} AND workspaceId = ${WS}`)) as unknown as [Array<{ n: number }>])[0][0]!;
    expect(Number(raw.n)).toBe(events.length);
  });

  it("resumes after a simulated crash from the SQL events without repeating completed tool calls", async () => {
    await seed();
    const t1 = new FakeTools();
    const crash = fakeCtx({ onCheckpoint: (c) => { if (c === 4) throw new Error("simulated process crash"); } });
    await expect(createSentinelInvestigateHandler(deps({ transportFor: () => t1, modelFor: () => goodModel() }))(crash.ctx)).rejects.toThrow(/simulated process crash/);
    const mid = await store.readEvents(WS, ID); expect(mid.length).toBeGreaterThan(0); expect((await store.get(WS, ID))!.status).toBe("RUNNING");
    const t2 = new FakeTools(); t2.n = 100; const { ctx } = fakeCtx({ attempt: 2 });
    const out = await createSentinelInvestigateHandler(deps({ transportFor: () => t2, modelFor: () => goodModel() }))(ctx) as { status: string };
    expect(out.status).toBe("COMPLETED");
    const events = await store.readEvents(WS, ID);
    expect(verifyTrace(events, ID).ok).toBe(true);
    const executed = [...t1.calls, ...t2.calls].map((c) => c.tool);
    expect(executed.length).toBeLessThanOrEqual(3);                              // at most one read-only call re-executed (documented at-least-once window)
    expect(new Set(executed)).toEqual(new Set(["logs.search", "metrics.query"]));
  });

  it("refuses to run an investigation id from another workspace (tenant isolation through SQL)", async () => {
    await seed();
    const { ctx } = fakeCtx({ task: { workspaceId: 99 } });
    await expect(createSentinelInvestigateHandler(deps({ transportFor: () => new FakeTools(), modelFor: () => goodModel() }))(ctx)).rejects.toThrow(/not found in task workspace/);
    expect((await store.readEvents(WS, ID)).length).toBe(0);
  });

  it("the proposal's tables use InnoDB and a composite event key", async () => {
    const rows = ((await db.db.execute(sql`SELECT TABLE_NAME AS t, ENGINE AS e FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE 'sentinel%'`)) as unknown as [Array<{ t: string; e: string }>])[0];
    expect(rows.map((r) => r.t).sort()).toEqual(names.slice().sort()); expect(rows.every((r) => r.e === "InnoDB")).toBe(true);
    const pk = ((await db.db.execute(sql`SELECT COLUMN_NAME AS c FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sentinelEvents' AND CONSTRAINT_NAME = 'PRIMARY' ORDER BY ORDINAL_POSITION`)) as unknown as [Array<{ c: string }>])[0];
    expect(pk.map((r) => r.c)).toEqual(["investigationId", "seq"]);
  });
});
