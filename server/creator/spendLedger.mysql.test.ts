import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import mysql from "mysql2";
import { drizzle } from "drizzle-orm/mysql2";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { createTestDatabase, skipMysqlSuite, type TestDatabase } from "../testing/mysqlTestDb";
import { MysqlCreatorSpendLedger, creatorHoldId, type CreatorSpendReserveInput } from "./spendLedger";
import type { CreatorSpendLimits } from "./paidPolicy";

/**
 * Real-SQL Creator spend ledger tests. Every "instance" owns its own pool, so contention goes through InnoDB exactly
 * as it does across several server processes (migration 0011 applied by createTestDatabase).
 */
describe.skipIf(skipMysqlSuite())("Creator spend ledger (MySQL, multi-instance)", () => {
  let database: TestDatabase;
  const pools: Array<ReturnType<typeof mysql.createPool>> = [];
  const instance = (now: () => number = () => Date.UTC(2026, 9, 10, 12)) => {
    const url = new URL(database.url);
    const pool = mysql.createPool({ host: url.hostname, port: Number(url.port), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database: database.name, connectionLimit: 10 });
    pools.push(pool);
    const db = drizzle(pool);
    return new MysqlCreatorSpendLedger(() => Promise.resolve(db), now);
  };
  const limits = (overrides: Partial<CreatorSpendLimits> = {}): CreatorSpendLimits => ({
    globalGenerations: 1000, globalCost: 1000, workspaceGenerations: 1000, workspaceCost: 1000, userGenerations: 1000, userCost: 1000, ...overrides,
  });
  const req = (o: Partial<CreatorSpendReserveInput> = {}): CreatorSpendReserveInput => ({
    holdId: creatorHoldId(o.workspaceId ?? 1, randomUUID()), workspaceId: 1, userId: 11, kind: "VIDEO", model: "veo-3.1-fast-generate-preview", cost: 0.8, limits: limits(), ...o,
  });
  const window = async (scope: string, day = "2026-10-10") => {
    const [rows] = (await database.db.execute(sql`SELECT generations, cost FROM creatorSpendWindows WHERE scope = ${scope} AND windowStart = ${day}`)) as unknown as [Array<{ generations: number; cost: string }>];
    return rows[0] ? { generations: Number(rows[0].generations), cost: Number(rows[0].cost) } : { generations: 0, cost: 0 };
  };
  const holdState = async (id: string) => {
    const [rows] = (await database.db.execute(sql`SELECT state, generationId FROM creatorSpendHolds WHERE id = ${id}`)) as unknown as [Array<{ state: string; generationId: number | null }>];
    return rows[0];
  };

  beforeAll(async () => { database = await createTestDatabase(); });
  afterAll(async () => { for (const pool of pools) await pool.promise().end().catch(() => undefined); await database?.close(); });
  beforeEach(async () => {
    await database.db.execute(sql`DELETE FROM creatorSpendHolds`);
    await database.db.execute(sql`DELETE FROM creatorSpendWindows`);
  });

  it("concurrent reservations from two instances: exactly the allowed number succeed (generations cap)", async () => {
    const [a, b] = [instance(), instance()];
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).reserve(req({ limits: limits({ globalGenerations: 7 }) }))));
    expect(results.filter(r => r.ok)).toHaveLength(7);
    expect(results.filter(r => !r.ok).every(r => !r.ok && r.reason === "global_exhausted")).toBe(true);
    expect(await window("global")).toEqual({ generations: 7, cost: 5.6 });
    const [holds] = (await database.db.execute(sql`SELECT COUNT(*) AS n FROM creatorSpendHolds`)) as unknown as [Array<{ n: number }>];
    expect(Number(holds[0].n)).toBe(7); // denied attempts leave no hold rows
  });

  it("concurrent reservations respect the cost cap exactly", async () => {
    const [a, b] = [instance(), instance()];
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? a : b).reserve(req({ cost: 0.75, limits: limits({ globalCost: 3 }) }))));
    expect(results.filter(r => r.ok)).toHaveLength(4);
    expect(await window("global")).toEqual({ generations: 4, cost: 3 });
  });

  it("all-or-nothing: a user-scope denial rolls back the global and workspace increments and the hold", async () => {
    const ledger = instance();
    await ledger.reserve(req({ userId: 5 }));
    const denied = await ledger.reserve(req({ userId: 5, limits: limits({ userGenerations: 1 }) }));
    expect(denied).toEqual({ ok: false, reason: "user_exhausted" });
    expect(await window("global")).toEqual({ generations: 1, cost: 0.8 });
    expect(await window("workspace:1")).toEqual({ generations: 1, cost: 0.8 });
    expect(await window("user:5")).toEqual({ generations: 1, cost: 0.8 });
  });

  it("workspace isolation: workspace A at its cap does not block workspace B; global cap blocks both", async () => {
    const ledger = instance();
    const capped = limits({ workspaceGenerations: 1, globalGenerations: 3 });
    expect((await ledger.reserve(req({ workspaceId: 1, limits: capped }))).ok).toBe(true);
    expect(await ledger.reserve(req({ workspaceId: 1, limits: capped }))).toEqual({ ok: false, reason: "workspace_exhausted" });
    expect((await ledger.reserve(req({ workspaceId: 2, userId: 12, limits: capped }))).ok).toBe(true);
    expect((await ledger.reserve(req({ workspaceId: 3, userId: 13, limits: capped }))).ok).toBe(true);
    expect(await ledger.reserve(req({ workspaceId: 4, userId: 14, limits: capped }))).toEqual({ ok: false, reason: "global_exhausted" });
  });

  it("same hold id reserved concurrently by two instances counts exactly once", async () => {
    const [a, b] = [instance(), instance()];
    const holdId = creatorHoldId(1, randomUUID());
    const results = await Promise.all([a.reserve(req({ holdId })), b.reserve(req({ holdId })), a.reserve(req({ holdId })), b.reserve(req({ holdId }))]);
    expect(results.filter(r => r.ok && r.created)).toHaveLength(1);
    expect(results.every(r => r.ok)).toBe(true);
    expect(await window("global")).toEqual({ generations: 1, cost: 0.8 });
  });

  it("release restores every scope exactly once, even when called concurrently from two instances", async () => {
    const [a, b] = [instance(), instance()];
    const input = req();
    await a.reserve(input);
    await Promise.all([a.release(input.holdId), b.release(input.holdId), a.release(input.holdId)]);
    expect((await holdState(input.holdId)).state).toBe("RELEASED");
    for (const scope of ["global", "workspace:1", "user:11"]) expect(await window(scope)).toEqual({ generations: 0, cost: 0 });
  });

  it("commit is final: a later release is a no-op and the spend stays counted", async () => {
    const ledger = instance();
    const input = req();
    await ledger.reserve(input);
    await ledger.commit(input.holdId, 42);
    await ledger.release(input.holdId);
    expect(await holdState(input.holdId)).toEqual({ state: "COMMITTED", generationId: 42 });
    expect(await window("global")).toEqual({ generations: 1, cost: 0.8 });
  });

  it("ambiguous outcome: recordUnknown links the generation and keeps the hold HELD and counted", async () => {
    const ledger = instance();
    const input = req();
    await ledger.reserve(input);
    await ledger.recordUnknown(input.holdId, 77);
    expect(await holdState(input.holdId)).toEqual({ state: "HELD", generationId: 77 });
    expect(await window("global")).toEqual({ generations: 1, cost: 0.8 });
  });

  it("a released key cannot be re-reserved to get a second provider call under the same key", async () => {
    const ledger = instance();
    const input = req();
    await ledger.reserve(input);
    await ledger.release(input.holdId);
    expect(await ledger.reserve(input)).toEqual({ ok: true, created: false });
    expect(await window("global")).toEqual({ generations: 0, cost: 0 });
  });

  it("budgets are per UTC day", async () => {
    const day1 = instance(() => Date.UTC(2026, 9, 10, 23, 59));
    const day2 = instance(() => Date.UTC(2026, 9, 11, 0, 1));
    const capped = limits({ globalGenerations: 1 });
    expect((await day1.reserve(req({ limits: capped }))).ok).toBe(true);
    expect((await day1.reserve(req({ limits: capped }))).ok).toBe(false);
    expect((await day2.reserve(req({ limits: capped }))).ok).toBe(true);
    expect(await window("global", "2026-10-11")).toEqual({ generations: 1, cost: 0.8 });
  });

  it("fails closed when the database is unavailable", async () => {
    const ledger = new MysqlCreatorSpendLedger(() => Promise.resolve(null));
    await expect(ledger.reserve(req())).rejects.toThrow("CREATOR_SPEND_LEDGER_UNAVAILABLE");
  });

  it("rejects a negative or non-finite cost", async () => {
    const ledger = instance();
    await expect(ledger.reserve(req({ cost: -1 }))).rejects.toThrow("CREATOR_SPEND_INVALID_COST");
    await expect(ledger.reserve(req({ cost: Number.NaN }))).rejects.toThrow("CREATOR_SPEND_INVALID_COST");
  });
});
