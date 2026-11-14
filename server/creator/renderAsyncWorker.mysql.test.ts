import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDatabase, skipMysqlSuite, type TestDatabase } from "../testing/mysqlTestDb";
import { MysqlCreatorRenderClaims } from "./renderClaims";
import { listQueuedCreatorRenders, quarantineExpiredCreatorRenderClaims, runCreatorRenderQueueBatch } from "./renderAsyncWorker";

describe.skipIf(skipMysqlSuite())("Creator bounded asynchronous queue MySQL", { timeout: 60_000 }, () => {
  let d: TestDatabase;
  let claims: MysqlCreatorRenderClaims;
  const scope = { workspaceId: 981, creatorProjectId: 982, timelineId: 983 };
  const enabled = { CREATOR_ASYNC_RENDER_WORKER_ENABLED: "true" };

  beforeAll(async () => {
    d = await createTestDatabase();
    claims = new MysqlCreatorRenderClaims(async () => d.db);
  });
  afterAll(async () => { await d?.close(); });

  async function seed(leaseSeconds = 600) {
    const fingerprint = randomBytes(32).toString("hex");
    const parametersJson = JSON.stringify({
      intentFingerprint: fingerprint, mode: "MASTER_CANDIDATE",
      rendererVersion: "ffmpeg-v1", fontFamily: "Noto Sans Tamil",
      derivativeOfRenderAssetId: null,
    });
    const [exp] = await d.db.execute(sql`
      INSERT INTO creatorExports
        (workspaceId, creatorProjectId, timelineId, status, width, height,
         format, renderer, parametersJson)
      VALUES (${scope.workspaceId}, ${scope.creatorProjectId}, ${scope.timelineId},
        'QUEUED', 1920, 1080, 'mp4', 'ffmpeg', ${parametersJson})
    `);
    const exportId = Number((exp as { insertId?: number }).insertId);
    const [claim] = await d.db.execute(sql`
      INSERT INTO creatorRenderClaims
        (workspaceId, creatorProjectId, timelineId, mode, fingerprint,
         leaseToken, leaseUntil, state, exportId)
      VALUES (${scope.workspaceId}, ${scope.creatorProjectId}, ${scope.timelineId},
        'MASTER_CANDIDATE', ${fingerprint}, ${randomUUID()},
        DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ${leaseSeconds} SECOND),
        'RUNNING', ${exportId})
    `);
    const claimId = Number((claim as { insertId?: number }).insertId);
    expect(claimId).toBeGreaterThan(0);
    return { claimId, exportId, fingerprint };
  }

  it("discovers only active queued exports from the existing durable tables", async () => {
    const active = await seed();
    const expired = await seed(-20);
    const rows = await listQueuedCreatorRenders(8, async () => d.db);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ claimId: active.claimId, exportId: active.exportId, fingerprint: active.fingerprint }),
    ]));
    expect(rows.some(row => row.claimId === expired.claimId)).toBe(false);
    await claims.cancelFencedClaim({ ...scope, claimId: active.claimId });
    const afterCancel = await listQueuedCreatorRenders(8, async () => d.db);
    expect(afterCancel.some(row => row.claimId === active.claimId)).toBe(false);
  });

  it("two worker batches racing for one claim launch at most one execution", async () => {
    const item = await seed();
    const rows = await listQueuedCreatorRenders(8, async () => d.db);
    const row = rows.find(row => row.claimId === item.claimId);
    expect(row).toBeDefined();
    if (!row) throw new Error("TEST_QUEUE_ROW_MISSING");
    let executed = 0;
    const dispatch = async () => {
      const lease = await claims.acquireQueuedExport({ ...scope, claimId: item.claimId }, 60);
      if (!lease) throw new Error("CREATOR_RENDER_DISPATCH_WORKER_NOT_ACQUIRED");
      executed++;
      return { reviewDecision: "PENDING" };
    };
    const [a, b] = await Promise.all([
      runCreatorRenderQueueBatch(1, { env: enabled, load: async () => [row], dispatch }),
      runCreatorRenderQueueBatch(1, { env: enabled, load: async () => [row], dispatch }),
    ]);
    expect(executed).toBe(1);
    expect(a.dispatched + b.dispatched).toBe(1);
    expect(a.skipped + b.skipped).toBe(1);
    const [result] = await d.db.execute(sql`
      SELECT status FROM creatorExports WHERE id = ${item.exportId}
    `) as unknown as [[{ status: string }]];
    expect(result[0].status).toBe("RUNNING");
  });
  it("quarantines expired queued and running claims without requeueing", async () => {
    const expiredQueued = await seed(-10);
    const expiredRunning = await seed(-10);
    const active = await seed(600);
    await d.db.execute(sql`
      UPDATE creatorExports SET status = 'RUNNING' WHERE id = ${expiredRunning.exportId}
    `);
    const changed = await quarantineExpiredCreatorRenderClaims(8, async () => d.db);
    expect(changed).toEqual(expect.arrayContaining([expiredQueued.claimId, expiredRunning.claimId]));
    expect(changed).not.toContain(active.claimId);
    const [states] = await d.db.execute(sql`
      SELECT id, state FROM creatorRenderClaims
      WHERE id IN (${expiredQueued.claimId}, ${expiredRunning.claimId}, ${active.claimId})
    `) as unknown as [Array<{ id: number; state: string }>];
    expect(states.find(row => row.id === expiredQueued.claimId)?.state).toBe("NEEDS_RECONCILIATION");
    expect(states.find(row => row.id === expiredRunning.claimId)?.state).toBe("NEEDS_RECONCILIATION");
    expect(states.find(row => row.id === active.claimId)?.state).toBe("RUNNING");
    const again = await quarantineExpiredCreatorRenderClaims(8, async () => d.db);
    expect(again).not.toContain(expiredQueued.claimId);
    expect(again).not.toContain(expiredRunning.claimId);
  });

  it("does not quarantine a claim whose lease has been renewed", async () => {
    const renewed = await seed(-1);
    await d.db.execute(sql`
      UPDATE creatorRenderClaims
      SET leaseUntil = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 600 SECOND)
      WHERE id = ${renewed.claimId}
    `);
    const changed = await quarantineExpiredCreatorRenderClaims(8, async () => d.db);
    expect(changed).not.toContain(renewed.claimId);
    const [rows] = await d.db.execute(sql`
      SELECT state FROM creatorRenderClaims WHERE id = ${renewed.claimId}
    `) as unknown as [[{ state: string }]];
    expect(rows[0].state).toBe("RUNNING");
  });

});
