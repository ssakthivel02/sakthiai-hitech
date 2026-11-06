import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import mysql from "mysql2";
import { drizzle } from "drizzle-orm/mysql2";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { createTestDatabase, skipMysqlSuite, type TestDatabase } from "../testing/mysqlTestDb";
import { MysqlCreatorSpendLedger, creatorHoldId } from "./spendLedger";
import { RESERVATION_EXPIRED, classifyStaleHold, reconcileCreatorSpend, resolveCreatorSpendHold } from "./spendReconciler";
import { creatorSpendSummary } from "./spendAdmin";
import type { CreatorSpendLimits } from "./paidPolicy";

/** Real-SQL reconciliation of stale Creator reservations (migrations 0011 + 0012 applied by createTestDatabase). */
describe.skipIf(skipMysqlSuite())("Creator spend reconciliation (MySQL)", () => {
  let database: TestDatabase;
  let pool: ReturnType<typeof mysql.createPool>;
  let getDb: () => Promise<ReturnType<typeof drizzle>>;
  let ledger: MysqlCreatorSpendLedger;
  const limits: CreatorSpendLimits = { globalGenerations: 100, globalCost: 100, workspaceGenerations: 100, workspaceCost: 100, userGenerations: 100, userCost: 100 };
  const q = async <T>(statement: ReturnType<typeof sql>) => ((await database.db.execute(statement)) as unknown as [T[]])[0];

  beforeAll(async () => {
    database = await createTestDatabase();
    const url = new URL(database.url);
    pool = mysql.createPool({ host: url.hostname, port: Number(url.port), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database: database.name, connectionLimit: 6 });
    const db = drizzle(pool);
    getDb = () => Promise.resolve(db);
    ledger = new MysqlCreatorSpendLedger(getDb);
  });
  afterAll(async () => { await pool?.promise().end().catch(() => undefined); await database?.close(); });
  beforeEach(async () => {
    for (const t of ["creatorSpendHolds", "creatorSpendWindows", "creatorProviderJobs", "creatorGenerations"]) await database.db.execute(sql.raw(`DELETE FROM ${t}`));
  });

  /** A generation + its reserved hold, aged `minutes` minutes. */
  async function seed(opts: { status: string; failureClass?: string | null; providerJob?: boolean; minutes?: number; workspaceId?: number; cost?: number }) {
    const workspaceId = opts.workspaceId ?? 1;
    const key = randomUUID();
    await database.db.execute(sql`INSERT INTO creatorGenerations (workspaceId, creatorProjectId, shotId, idempotencyKey, kind, provider, model, parametersJson, status, failureClass)
      VALUES (${workspaceId}, 1, 1, ${key}, 'VIDEO', 'google-veo', 'veo', '{}', ${opts.status}, ${opts.failureClass ?? null})`);
    const [{ id }] = await q<{ id: number }>(sql`SELECT id FROM creatorGenerations WHERE idempotencyKey = ${key}`);
    const holdId = creatorHoldId(workspaceId, key);
    const reserved = await ledger.reserve({ holdId, workspaceId, userId: 11, kind: "VIDEO", model: "veo", cost: opts.cost ?? 0.8, limits });
    expect(reserved).toEqual({ ok: true, created: true });
    if (opts.providerJob) await database.db.execute(sql`INSERT INTO creatorProviderJobs (workspaceId, creatorProjectId, generationId, provider, providerJobId, status) VALUES (${workspaceId}, 1, ${id}, 'google-veo', ${"op-" + key}, 'RUNNING')`);
    await database.db.execute(sql`UPDATE creatorSpendHolds SET createdAt = CURRENT_TIMESTAMP - INTERVAL ${opts.minutes ?? 120} MINUTE WHERE id = ${holdId}`);
    return { holdId, generationId: Number(id) };
  }
  const hold = async (id: string) => (await q<{ state: string; generationId: number | null; settledBy: string | null; settlementNote: string | null }>(sql`SELECT state, generationId, settledBy, settlementNote FROM creatorSpendHolds WHERE id = ${id}`))[0];
  const global = async () => { const [w] = await q<{ generations: number; cost: string }>(sql`SELECT generations, cost FROM creatorSpendWindows WHERE scope = 'global'`); return { generations: Number(w?.generations ?? 0), cost: Number(w?.cost ?? 0) }; };

  it("dry-run classifies every stale hold and changes nothing", async () => {
    await seed({ status: "RUNNING", providerJob: true });
    await seed({ status: "QUEUED" });
    await seed({ status: "SUBMISSION_UNKNOWN", failureClass: "TIMEOUT" });
    const report = await reconcileCreatorSpend({ getDb, ledger, apply: false });
    expect(report).toMatchObject({ dryRun: true, scanned: 3, commit: 1, release: 1, manual: 1, applied: { commit: 0, release: 0 } });
    expect((await q<{ n: number }>(sql`SELECT COUNT(*) AS n FROM creatorSpendHolds WHERE state = 'HELD'`))[0].n).toBe(3);
    expect(await global()).toEqual({ generations: 3, cost: 2.4 });
  });

  it("provider job exists → COMMIT, counted, audit records the reconciler", async () => {
    const s = await seed({ status: "RUNNING", providerJob: true });
    const report = await reconcileCreatorSpend({ getDb, ledger, apply: true });
    expect(report.applied).toEqual({ commit: 1, release: 0 });
    expect(await hold(s.holdId)).toMatchObject({ state: "COMMITTED", generationId: s.generationId, settledBy: "reconciler", settlementNote: "provider_job_exists" });
    expect(await global()).toEqual({ generations: 1, cost: 0.8 });
  });

  it("QUEUED (never submitted) → generation closed first, then RELEASED, counters restored", async () => {
    const s = await seed({ status: "QUEUED" });
    await reconcileCreatorSpend({ getDb, ledger, apply: true });
    expect(await hold(s.holdId)).toMatchObject({ state: "RELEASED", settledBy: "reconciler", settlementNote: "never_submitted" });
    expect(await global()).toEqual({ generations: 0, cost: 0 });
    const [g] = await q<{ status: string; failureClass: string; errorMessage: string }>(sql`SELECT status, failureClass, errorMessage FROM creatorGenerations WHERE id = ${s.generationId}`);
    expect(g).toEqual({ status: "FAILED", failureClass: "QUOTA", errorMessage: RESERVATION_EXPIRED });
  });

  it("a slow in-flight request cannot submit a generation the reconciler closed (QUEUED guard)", async () => {
    const s = await seed({ status: "QUEUED" });
    await reconcileCreatorSpend({ getDb, ledger, apply: true });
    // the in-flight request's beginProviderSubmission uses `WHERE status = 'QUEUED'` -> 0 rows -> CREATOR_SUBMISSION_STATE_CONFLICT
    const moved = await database.db.execute(sql`UPDATE creatorGenerations SET status = 'SUBMISSION_UNKNOWN' WHERE id = ${s.generationId} AND status = 'QUEUED'`);
    expect(Number((moved as unknown as [{ affectedRows: number }])[0].affectedRows)).toBe(0);
  });

  it("definitive failure without provider job → RELEASE; ambiguous failure → MANUAL (stays HELD)", async () => {
    const definitive = await seed({ status: "FAILED", failureClass: "INVALID_REQUEST" });
    const ambiguous = await seed({ status: "FAILED", failureClass: "TIMEOUT" });
    const unknown = await seed({ status: "SUBMISSION_UNKNOWN", failureClass: "NETWORK" });
    const report = await reconcileCreatorSpend({ getDb, ledger, apply: true });
    expect(report.applied).toEqual({ commit: 0, release: 1 });
    expect((await hold(definitive.holdId)).state).toBe("RELEASED");
    expect((await hold(ambiguous.holdId)).state).toBe("HELD");
    expect((await hold(unknown.holdId)).state).toBe("HELD");
    expect(await global()).toEqual({ generations: 2, cost: 1.6 });
  });

  it("FAILED after a provider job existed → COMMIT (the provider accepted, assume billed)", async () => {
    const s = await seed({ status: "FAILED", failureClass: "CONTENT_POLICY", providerJob: true });
    await reconcileCreatorSpend({ getDb, ledger, apply: true });
    expect((await hold(s.holdId)).state).toBe("COMMITTED");
  });

  it("fresh holds (younger than the window) are never touched; windows under 15 minutes are refused", async () => {
    const s = await seed({ status: "QUEUED", minutes: 5 });
    expect((await reconcileCreatorSpend({ getDb, ledger, apply: true })).scanned).toBe(0);
    expect((await hold(s.holdId)).state).toBe("HELD");
    await expect(reconcileCreatorSpend({ getDb, ledger, apply: true, staleAfterMinutes: 5 })).rejects.toThrow("CREATOR_RECONCILE_WINDOW_TOO_SHORT");
  });

  it("apply is idempotent across two concurrent reconcilers (each hold settled once)", async () => {
    await seed({ status: "QUEUED" });
    await seed({ status: "RUNNING", providerJob: true });
    const other = new MysqlCreatorSpendLedger(getDb);
    const [a, b] = await Promise.all([reconcileCreatorSpend({ getDb, ledger, apply: true }), reconcileCreatorSpend({ getDb, ledger: other, apply: true })]);
    expect(a.applied.commit + b.applied.commit).toBe(1);
    expect(a.applied.release + b.applied.release).toBe(1);
    expect(await global()).toEqual({ generations: 1, cost: 0.8 });
  });

  it("administrator resolution of a MANUAL hold: note required, decision recorded, second decision is a no-op", async () => {
    const s = await seed({ status: "SUBMISSION_UNKNOWN", failureClass: "TIMEOUT" });
    await expect(resolveCreatorSpendHold({ getDb, ledger, holdId: s.holdId, outcome: "not_charged", adminUserId: 9, note: "short" })).rejects.toThrow("CREATOR_RESOLUTION_NOTE_REQUIRED");
    const first = await resolveCreatorSpendHold({ getDb, ledger, holdId: s.holdId, outcome: "not_charged", adminUserId: 9, note: "Google console shows no operation for this key" });
    expect(first).toEqual({ applied: true, state: "RELEASED" });
    expect(await hold(s.holdId)).toMatchObject({ settledBy: "admin:9", settlementNote: "not_charged: Google console shows no operation for this key", generationId: null });
    expect(await resolveCreatorSpendHold({ getDb, ledger, holdId: s.holdId, outcome: "charged", adminUserId: 9, note: "changed my mind later" })).toEqual({ applied: false, state: "RELEASED" });
    expect(await global()).toEqual({ generations: 0, cost: 0 });
    await expect(resolveCreatorSpendHold({ getDb, ledger, holdId: "ws:1:nope", outcome: "charged", adminUserId: 9, note: "does not exist here" })).rejects.toThrow("CREATOR_SPEND_HOLD_NOT_FOUND");
  });

  it("summary: global/workspace/user totals, states, stale count, recent holds with audit fields — no credentials", async () => {
    await seed({ status: "RUNNING", providerJob: true, workspaceId: 1 });
    await seed({ status: "QUEUED", workspaceId: 2, cost: 0.2 });
    await reconcileCreatorSpend({ getDb, ledger, apply: true });
    await seed({ status: "SUBMISSION_UNKNOWN", failureClass: "TIMEOUT", workspaceId: 2 });
    const summary = await creatorSpendSummary(getDb, 60, { CREATOR_PAID_GENERATION_ENABLED: "true", CREATOR_PAID_IMAGE_USERS: "a,b", CREATOR_PAID_VIDEO_USERS: "secret-open-id" });
    expect(summary.global).toEqual({ generations: 2, cost: 1.6 });
    expect(summary.topWorkspaces).toEqual(expect.arrayContaining([{ id: 1, generations: 1, cost: 0.8 }, { id: 2, generations: 1, cost: 0.8 }]));
    expect(summary.topUsers).toEqual([{ id: 11, generations: 2, cost: 1.6 }]);
    expect(summary.holdsToday).toMatchObject({ COMMITTED: { holds: 1 }, RELEASED: { holds: 1 }, HELD: { holds: 1 } });
    expect(summary.staleHeld.holds).toBe(1);
    expect(summary.allowlistedUsers).toEqual({ image: 2, video: 1 });
    expect(summary.policy).toMatchObject({ enabled: true, valid: false });
    expect(summary.recentHolds.find(h => h.state === "RELEASED")).toMatchObject({ settledBy: "reconciler", settlementNote: "never_submitted" });
    expect(JSON.stringify(summary)).not.toContain("secret-open-id");
  });
});

describe("classifyStaleHold (pure)", () => {
  const c = (generationStatus: string | null, failureClass: string | null = null, providerJobs = 0, generationId: number | null = 1) => classifyStaleHold({ generationId, generationStatus, failureClass, providerJobs }).action;
  it("maps every generation state conservatively", () => {
    expect(c(null, null, 0, null)).toBe("MANUAL");
    for (const s of ["SUBMITTED", "RUNNING", "SUCCEEDED", "RETRYABLE"]) expect(c(s)).toBe("COMMIT");
    expect(c("QUEUED")).toBe("RELEASE");
    expect(c("SUBMISSION_UNKNOWN", "TIMEOUT")).toBe("MANUAL");
    expect(c("SUBMISSION_UNKNOWN", null, 1)).toBe("COMMIT");
    for (const f of ["AUTH", "QUOTA", "RATE_LIMIT", "INVALID_REQUEST", "CONTENT_POLICY"]) expect(c("FAILED", f)).toBe("RELEASE");
    for (const f of ["NETWORK", "TIMEOUT", "PROVIDER_UNAVAILABLE", "UNKNOWN"]) expect(c("FAILED", f)).toBe("MANUAL");
    expect(c("FAILED", null)).toBe("MANUAL");
    expect(c("CANCELLED", null)).toBe("RELEASE");
    expect(c("CANCELLED", "TIMEOUT")).toBe("MANUAL");
    expect(c("SOMETHING_NEW")).toBe("MANUAL");
  });
});
