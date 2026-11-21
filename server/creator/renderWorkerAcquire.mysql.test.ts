import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDatabase, skipMysqlSuite, type TestDatabase } from "../testing/mysqlTestDb";
import { MysqlCreatorRenderClaims } from "./renderClaims";

/**
 * Disposable MySQL 8.0/8.4: one queued export can be acquired by only one
 * worker; failures roll back the token rotation and export transition.
 * This test does not launch FFmpeg or enable an async worker.
 */
describe.skipIf(skipMysqlSuite())("Creator queued export worker acquisition", { timeout: 60_000 }, () => {
  let d: TestDatabase;
  let claims: MysqlCreatorRenderClaims;
  const scope = { workspaceId: 801, creatorProjectId: 802, timelineId: 803 };
  const exec = (statement: ReturnType<typeof sql>) => d.db.execute(statement);

  beforeAll(async () => {
    d = await createTestDatabase();
    claims = new MysqlCreatorRenderClaims(async () => d.db);
  });
  afterAll(async () => { await d?.close(); });

  async function seed(leaseOffsetSeconds = 600) {
    const fingerprint = randomBytes(32).toString("hex");
    const originalToken = randomUUID();
    const exported = await exec(sql`
      INSERT INTO creatorExports
        (workspaceId, creatorProjectId, timelineId, status, width, height,
         format, renderer, parametersJson)
      VALUES (${scope.workspaceId}, ${scope.creatorProjectId}, ${scope.timelineId},
        'QUEUED', 1920, 1080, 'mp4', 'ffmpeg', '{}')
    `);
    const exportId = Number((exported[0] as { insertId?: number }).insertId);
    const inserted = await exec(sql`
      INSERT INTO creatorRenderClaims
        (workspaceId, creatorProjectId, timelineId, mode, fingerprint,
         leaseToken, leaseUntil, state, exportId)
      VALUES (${scope.workspaceId}, ${scope.creatorProjectId}, ${scope.timelineId},
        'MASTER_CANDIDATE', ${fingerprint}, ${originalToken},
        DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ${leaseOffsetSeconds} SECOND),
        'RUNNING', ${exportId})
    `);
    const claimId = Number((inserted[0] as { insertId?: number }).insertId);
    expect(exportId).toBeGreaterThan(0);
    expect(claimId).toBeGreaterThan(0);
    return {
      claimId, exportId, originalToken, fingerprint,
      input: { ...scope, claimId },
    };
  }

  it("acquires exactly once under concurrent workers and fences the reservation token", async () => {
    const x = await seed();
    const [a, b] = await Promise.all([
      claims.acquireQueuedExport(x.input, 60),
      claims.acquireQueuedExport(x.input, 60),
    ]);
    const leases = [a, b].filter((v): v is NonNullable<typeof v> => v !== null);
    expect(leases).toHaveLength(1);
    expect([a, b].filter(v => v === null)).toHaveLength(1);
    const lease = leases[0];
    expect(lease).toMatchObject({
      claimId: x.claimId, exportId: x.exportId,
      scope: { ...scope, mode: "MASTER_CANDIDATE", fingerprint: x.fingerprint },
    });
    expect(lease.leaseToken).not.toBe(x.originalToken);
    expect(await claims.heartbeat(lease.scope, x.originalToken, 60)).toBe(false);
    expect(await claims.heartbeat(lease.scope, lease.leaseToken, 60)).toBe(true);
    const [rows] = await exec(sql`
      SELECT c.state, c.leaseToken, e.status AS exportStatus
      FROM creatorRenderClaims c JOIN creatorExports e ON e.id = c.exportId
      WHERE c.id = ${x.claimId}
    `) as unknown as [[{ state: string; leaseToken: string; exportStatus: string }]];
    expect(rows[0]).toMatchObject({
      state: "RUNNING", leaseToken: lease.leaseToken, exportStatus: "RUNNING",
    });
  });

  it("quarantines an expired queued claim without issuing a worker lease", async () => {
    const x = await seed(-10);
    expect(await claims.acquireQueuedExport(x.input)).toBeNull();
    expect(await claims.acquireQueuedExport(x.input)).toBeNull();
    const [rows] = await exec(sql`
      SELECT c.state, c.leaseToken, e.status AS exportStatus
      FROM creatorRenderClaims c JOIN creatorExports e ON e.id = c.exportId
      WHERE c.id = ${x.claimId}
    `) as unknown as [[{ state: string; leaseToken: string; exportStatus: string }]];
    expect(rows[0]).toMatchObject({
      state: "NEEDS_RECONCILIATION",
      leaseToken: x.originalToken,
      exportStatus: "QUEUED",
    });
  });

  it("refuses cross-tenant, cross-project and cross-timeline acquisition", async () => {
    const x = await seed();
    expect(await claims.acquireQueuedExport({ ...x.input, workspaceId: 999 })).toBeNull();
    expect(await claims.acquireQueuedExport({ ...x.input, creatorProjectId: 999 })).toBeNull();
    expect(await claims.acquireQueuedExport({ ...x.input, timelineId: 999 })).toBeNull();
    expect(await claims.acquireQueuedExport(x.input)).not.toBeNull();
  });

  it("cannot acquire a completed claim even when its export is still QUEUED", async () => {
    const x = await seed();
    await exec(sql`UPDATE creatorRenderClaims SET state = 'SUCCEEDED' WHERE id = ${x.claimId}`);
    expect(await claims.acquireQueuedExport(x.input)).toBeNull();
  });

  it("rolls back token rotation if export start fails", async () => {
    const x = await seed();
    await exec(sql`CREATE TRIGGER creatorWorkerExportAbort BEFORE UPDATE ON creatorExports
      FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'injected worker start failure'`);
    try {
      await expect(claims.acquireQueuedExport(x.input)).rejects.toThrow();
      const [rows] = await exec(sql`
        SELECT c.state, c.leaseToken, e.status AS exportStatus
        FROM creatorRenderClaims c JOIN creatorExports e ON e.id = c.exportId
        WHERE c.id = ${x.claimId}
      `) as unknown as [[{ state: string; leaseToken: string; exportStatus: string }]];
      expect(rows[0]).toMatchObject({
        state: "RUNNING", leaseToken: x.originalToken, exportStatus: "QUEUED",
      });
    } finally {
      await exec(sql`DROP TRIGGER IF EXISTS creatorWorkerExportAbort`);
    }
    expect(await claims.acquireQueuedExport(x.input)).not.toBeNull();
  });
});
