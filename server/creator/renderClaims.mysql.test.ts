import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import mysql from "mysql2";
import { drizzle } from "drizzle-orm/mysql2";
import { sql } from "drizzle-orm";
import { createTestDatabase, skipMysqlSuite, type TestDatabase } from "../testing/mysqlTestDb";
import { MysqlCreatorRenderClaims, type CreatorRenderClaimScope } from "./renderClaims";

/** Real InnoDB integration, against the harness's isolated throwaway database.
 * Every instance has its own connection pool; the unique key resolves concurrent writers.
 * The test harness rejects managed/production database hosts.
 */
describe.skipIf(skipMysqlSuite())("Creator render claim ledger (real MySQL, multiple instances)", () => {
  let database: TestDatabase;
  const pools: Array<ReturnType<typeof mysql.createPool>> = [];
  const instance = () => {
    const url = new URL(database.url);
    const pool = mysql.createPool({
      host: url.hostname, port: Number(url.port), user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password), database: database.name,
      connectionLimit: 10,
    });
    pools.push(pool);
    return new MysqlCreatorRenderClaims(() => Promise.resolve(drizzle(pool)));
  };
  const scope = (changes: Partial<CreatorRenderClaimScope> = {}): CreatorRenderClaimScope => ({
    workspaceId: 11, creatorProjectId: 22, timelineId: 33,
    mode: "MASTER_CANDIDATE", fingerprint: "a".repeat(64), ...changes,
  });
  const rows = async () => {
    const [result] = await database.db.execute(sql`
      SELECT workspaceId, creatorProjectId, timelineId, mode, fingerprint, state,
        exportId, outputAssetId, leaseToken, leaseUntil FROM creatorRenderClaims
    `) as unknown as [Array<{
      workspaceId: number; creatorProjectId: number; timelineId: number;
      mode: string; fingerprint: string; state: string;
      exportId: number | null; outputAssetId: number | null; leaseToken: string; leaseUntil: Date;
    }>];
    return result;
  };
  beforeAll(async () => { database = await createTestDatabase(); });
  afterAll(async () => {
    for (const pool of pools) await pool.promise().end().catch(() => undefined);
    await database?.close();
  });
  beforeEach(async () => { await database.db.execute(sql`DELETE FROM creatorRenderClaims`); });

  it("serializes 20 simultaneous identical claims across two independent pools", async () => {
    const a = instance(), b = instance();
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).claim(scope())));
    expect(results.filter(result => result.created)).toHaveLength(1);
    expect(new Set(results.map(result => result.claimId)).size).toBe(1);
    expect(results.filter(result => !result.created).every(result => !("leaseToken" in result))).toBe(true);
    expect((await rows())).toHaveLength(1);
    expect((await rows())[0].state).toBe("RUNNING");
  });

  it("keeps the same hash isolated across workspaces, projects, timelines, and modes", async () => {
    const a = instance();
    const scopes = [
      scope(), scope({ workspaceId: 12 }), scope({ creatorProjectId: 23 }),
      scope({ timelineId: 34 }), scope({ mode: "VERTICAL_DERIVATIVE" }),
    ];
    const result = await Promise.all(scopes.map(key => a.claim(key)));
    expect(result.every(item => item.created)).toBe(true);
    expect(new Set(result.map(item => item.claimId)).size).toBe(5);
    expect((await rows())).toHaveLength(5);
  });

  it("refuses a forged token and only completes the original, bound, unexpired claim once", async () => {
    const store = instance();
    const created = await store.claim(scope());
    if (!created.created) throw new Error("TEST_CLAIM_NOT_CREATED");
    expect(await store.bindExport(scope(), "00000000-0000-4000-8000-000000000000", 41)).toBe(false);
    expect(await store.complete(scope(), "00000000-0000-4000-8000-000000000000", 41, 45, "b".repeat(64))).toBe(false);
    expect(await store.complete(scope(), created.leaseToken, 41, 45, "b".repeat(64))).toBe(false);
    expect(await store.bindExport(scope(), created.leaseToken, 41)).toBe(true);
    expect(await store.bindExport(scope(), created.leaseToken, 41)).toBe(false);
    expect(await store.heartbeat(scope(), created.leaseToken, 1800)).toBe(true);
    expect(await store.complete(scope(), created.leaseToken, 41, 45, "b".repeat(64))).toBe(true);
    expect(await store.complete(scope(), created.leaseToken, 41, 46, "b".repeat(64))).toBe(false);
    expect(await store.heartbeat(scope(), created.leaseToken)).toBe(false);
    const reused = await store.claim(scope());
    expect(reused).toMatchObject({ created: false, claimId: created.claimId, state: "SUCCEEDED", exportId: 41, outputAssetId: 45 });
    expect((await rows())).toHaveLength(1);
  });

  it("quarantines expired claims and does not auto-retry or renew an expired lease", async () => {
    const a = instance(), b = instance();
    const created = await a.claim(scope());
    if (!created.created) throw new Error("TEST_CLAIM_NOT_CREATED");
    await database.db.execute(sql`
      UPDATE creatorRenderClaims SET leaseUntil = DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 SECOND)
      WHERE id = ${created.claimId}
    `);
    expect(await a.heartbeat(scope(), created.leaseToken)).toBe(false);
    const duplicate = await b.claim(scope());
    expect(duplicate).toMatchObject({ created: false, claimId: created.claimId, state: "NEEDS_RECONCILIATION" });
    expect(await a.bindExport(scope(), created.leaseToken, 55)).toBe(false);
    expect(await a.complete(scope(), created.leaseToken, 55, 66, "c".repeat(64))).toBe(false);
    expect((await rows())).toHaveLength(1);
  });

  it("marks ambiguous output outcomes as non-retryable until reconciliation", async () => {
    const a = instance(), b = instance();
    const created = await a.claim(scope());
    if (!created.created) throw new Error("TEST_CLAIM_NOT_CREATED");
    expect(await a.bindExport(scope(), created.leaseToken, 71)).toBe(true);
    expect(await a.markUnknown(scope(), created.leaseToken)).toBe(true);
    expect(await a.markUnknown(scope(), created.leaseToken)).toBe(false);
    const result = await b.claim(scope());
    expect(result).toMatchObject({ created: false, state: "NEEDS_RECONCILIATION", exportId: 71 });
    expect(await a.complete(scope(), created.leaseToken, 71, 72, "d".repeat(64))).toBe(false);
    expect((await rows())).toHaveLength(1);
  });

  it("validates input scope and refuses malformed leases or output identifiers", async () => {
    const a = instance();
    await expect(a.claim(scope({ fingerprint: "invalid" }))).rejects.toThrow("CREATOR_RENDER_CLAIM_FINGERPRINT_INVALID");
    await expect(a.claim(scope({ workspaceId: 0 }))).rejects.toThrow("CREATOR_RENDER_CLAIM_SCOPE_INVALID");
    await expect(a.claim(scope(), 0)).rejects.toThrow("CREATOR_RENDER_CLAIM_LEASE_INVALID");
    const created = await a.claim(scope());
    if (!created.created) throw new Error("TEST_CLAIM_NOT_CREATED");
    await expect(a.bindExport(scope(), created.leaseToken, 0)).rejects.toThrow("CREATOR_RENDER_CLAIM_ID_INVALID");
    await expect(a.complete(scope(), created.leaseToken, 8, 9, "not-hex")).rejects.toThrow("CREATOR_RENDER_CLAIM_OUTPUT_CHECKSUM_INVALID");
    expect((await rows())).toHaveLength(1);
  });
});
