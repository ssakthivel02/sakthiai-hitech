import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDatabase, skipMysqlSuite, type TestDatabase } from "../testing/mysqlTestDb";
import { MysqlCreatorRenderClaims } from "./renderClaims";

/** Disposable MySQL 8.0/8.4: cancellation is atomic and never restarts work. */
describe.skipIf(skipMysqlSuite())("Creator fenced render cancellation", { timeout: 60_000 }, () => {
  let d: TestDatabase;
  let claims: MysqlCreatorRenderClaims;
  const scope = { workspaceId: 981, creatorProjectId: 982, timelineId: 983 };
  beforeAll(async () => {
    d = await createTestDatabase();
    claims = new MysqlCreatorRenderClaims(async () => d.db);
  });
  afterAll(async () => { await d?.close(); });

  async function seed() {
    const fingerprint = randomBytes(32).toString("hex");
    const leaseToken = randomUUID();
    const [exportResult] = await d.db.execute(sql`
      INSERT INTO creatorExports
        (workspaceId, creatorProjectId, timelineId, status, width, height,
         format, renderer, parametersJson)
      VALUES (${scope.workspaceId}, ${scope.creatorProjectId}, ${scope.timelineId},
        'QUEUED', 1920, 1080, 'mp4', 'ffmpeg', '{}')
    `);
    const exportId = Number((exportResult as { insertId?: number }).insertId);
    const [claimResult] = await d.db.execute(sql`
      INSERT INTO creatorRenderClaims
        (workspaceId, creatorProjectId, timelineId, mode, fingerprint,
         leaseToken, leaseUntil, state, exportId)
      VALUES (${scope.workspaceId}, ${scope.creatorProjectId}, ${scope.timelineId},
        'MASTER_CANDIDATE', ${fingerprint}, ${leaseToken},
        DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 600 SECOND), 'RUNNING', ${exportId})
    `);
    const claimId = Number((claimResult as { insertId?: number }).insertId);
    expect(exportId).toBeGreaterThan(0);
    expect(claimId).toBeGreaterThan(0);
    return { input: { ...scope, claimId }, exportId, leaseToken, fingerprint };
  }

  async function states(claimId: number) {
    const [rows] = await d.db.execute(sql`
      SELECT c.state, e.status AS exportStatus, c.outputAssetId
      FROM creatorRenderClaims c JOIN creatorExports e ON e.id = c.exportId
      WHERE c.id = ${claimId}
    `) as unknown as [[{ state: string; exportStatus: string; outputAssetId: number | null }]];
    return rows[0];
  }

  it("cancels QUEUED work atomically and blocks worker acquisition", async () => {
    const x = await seed();
    const result = await claims.cancelFencedClaim(x.input);
    expect(result).toMatchObject({
      claimId: x.input.claimId, exportId: x.exportId,
      outcome: "CANCELLED_BEFORE_DISPATCH",
      requiresReconciliation: false, finalMaster: false, publishApproved: false,
    });
    expect(await states(x.input.claimId)).toMatchObject({
      state: "NEEDS_RECONCILIATION", exportStatus: "CANCELLED", outputAssetId: null,
    });
    expect(await claims.acquireQueuedExport(x.input)).toBeNull();
    expect(await claims.pollClaim(x.input)).toMatchObject({
      exportStatus: "CANCELLED", cancelled: true, requiresReconciliation: false,
    });
    expect(await claims.heartbeat({
      ...scope, mode: "MASTER_CANDIDATE", fingerprint: x.fingerprint,
    }, x.leaseToken)).toBe(false);
  });

  it("fences a RUNNING worker without claiming the FFmpeg process was killed", async () => {
    const x = await seed();
    const lease = await claims.acquireQueuedExport(x.input, 60);
    expect(lease).not.toBeNull();
    const result = await claims.cancelFencedClaim(x.input);
    expect(result).toMatchObject({ outcome: "RUNNING_FENCED", requiresReconciliation: true });
    expect(await states(x.input.claimId)).toMatchObject({
      state: "NEEDS_RECONCILIATION", exportStatus: "RUNNING", outputAssetId: null,
    });
    expect(await claims.heartbeat(lease!.scope, lease!.leaseToken)).toBe(false);
    expect(await claims.acquireQueuedExport(x.input)).toBeNull();
  });

  it("is idempotent and does not reactivate a quarantined claim", async () => {
    const x = await seed();
    await claims.cancelFencedClaim(x.input);
    const second = await claims.cancelFencedClaim(x.input);
    expect(second).toMatchObject({ outcome: "ALREADY_QUARANTINED", requiresReconciliation: false });
    expect((await states(x.input.claimId)).exportStatus).toBe("CANCELLED");
  });

  it("enforces workspace/project/timeline isolation before changing any row", async () => {
    const x = await seed();
    for (const key of ["workspaceId", "creatorProjectId", "timelineId"] as const) {
      await expect(claims.cancelFencedClaim({ ...x.input, [key]: 99999 }))
        .rejects.toThrow("CREATOR_RENDER_CLAIM_NOT_FOUND");
    }
    expect(await states(x.input.claimId)).toMatchObject({
      state: "RUNNING", exportStatus: "QUEUED",
    });
  });

  it("cannot cancel a completed claim or erase its output", async () => {
    const x = await seed();
    await d.db.execute(sql`
      UPDATE creatorRenderClaims SET state = 'SUCCEEDED', outputAssetId = 12345
      WHERE id = ${x.input.claimId}
    `);
    const result = await claims.cancelFencedClaim(x.input);
    expect(result).toMatchObject({ outcome: "ALREADY_SUCCEEDED", requiresReconciliation: false });
    expect(await states(x.input.claimId)).toMatchObject({
      state: "SUCCEEDED", exportStatus: "QUEUED", outputAssetId: 12345,
    });
  });

  it("serializes cancellation against competing worker acquisition", async () => {
    const x = await seed();
    const [cancel, lease] = await Promise.all([
      claims.cancelFencedClaim(x.input),
      claims.acquireQueuedExport(x.input, 60),
    ]);
    expect(["CANCELLED_BEFORE_DISPATCH", "RUNNING_FENCED"]).toContain(cancel.outcome);
    if (cancel.outcome === "CANCELLED_BEFORE_DISPATCH") expect(lease).toBeNull();
    expect((await states(x.input.claimId)).state).toBe("NEEDS_RECONCILIATION");
    expect(await claims.acquireQueuedExport(x.input)).toBeNull();
  });
});
