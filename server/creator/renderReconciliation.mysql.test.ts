import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDatabase, skipMysqlSuite, type TestDatabase } from "../testing/mysqlTestDb";
import { inspectQuarantinedCreatorRender } from "./renderReconciliation";

describe.skipIf(skipMysqlSuite())("Creator quarantined render storage evidence (disposable MySQL)", { timeout: 60_000 }, () => {
  let d: TestDatabase;
  const scope = { workspaceId: 991, creatorProjectId: 992, timelineId: 993 };
  const digest = createHash("sha256").update("test").digest("hex");

  beforeAll(async () => { d = await createTestDatabase(); });
  afterAll(async () => { await d?.close(); });

  async function seed(status: "RUNNING" | "CANCELLED" = "RUNNING") {
    const [exportResult] = await d.db.execute(sql`
      INSERT INTO creatorExports (workspaceId, creatorProjectId, timelineId, status,
        width, height, format, renderer, parametersJson)
      VALUES (${scope.workspaceId}, ${scope.creatorProjectId}, ${scope.timelineId},
        ${status}, 1920, 1080, 'mp4', 'ffmpeg', '{}')
    `);
    const exportId = Number((exportResult as { insertId?: number }).insertId);
    const fingerprint = randomBytes(32).toString("hex");
    const [claimResult] = await d.db.execute(sql`
      INSERT INTO creatorRenderClaims
        (workspaceId, creatorProjectId, timelineId, mode, fingerprint,
         leaseToken, leaseUntil, state, exportId)
      VALUES (${scope.workspaceId}, ${scope.creatorProjectId}, ${scope.timelineId},
        'MASTER_CANDIDATE', ${fingerprint}, ${randomUUID()},
        DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 10 SECOND),
        'NEEDS_RECONCILIATION', ${exportId})
    `);
    const claimId = Number((claimResult as { insertId?: number }).insertId);
    expect(claimId).toBeGreaterThan(0);
    return { ...scope, claimId, exportId };
  }

  it("does not scan storage or requeue a pre-dispatch cancelled claim", async () => {
    const item = await seed("CANCELLED");
    const listObjects = vi.fn(async () => []);
    const result = await inspectQuarantinedCreatorRender(item, {
      dbProvider: async () => d.db, listObjects,
    });
    expect(result).toMatchObject({
      outcome: "CANCELLED_BEFORE_DISPATCH", autoRetry: false,
      finalMaster: false, publishApproved: false,
    });
    expect(listObjects).not.toHaveBeenCalled();
  });

  it("never claims absence or success for a non-finalized orphan", async () => {
    const item = await seed();
    const key = `creator/${scope.workspaceId}/${scope.creatorProjectId}/renders/timeline-${scope.timelineId}/export-${item.exportId}_a0b1c2d3.mp4`;
    const orphan = await inspectQuarantinedCreatorRender(item, {
      dbProvider: async () => d.db,
      listObjects: async () => [{ key, sizeBytes: 4 }],
    });
    expect(orphan).toMatchObject({
      outcome: "UNVERIFIED_ORPHAN", observedObjects: 1,
      verifiedAssetId: null, autoRetry: false,
    });
    const none = await inspectQuarantinedCreatorRender(item, {
      dbProvider: async () => d.db, listObjects: async () => [],
    });
    expect(none.outcome).toBe("NO_OBJECT_OBSERVED");
    const [rows] = await d.db.execute(sql`
      SELECT state FROM creatorRenderClaims WHERE id = ${item.claimId}
    `) as unknown as [[{ state: string }]];
    expect(rows[0].state).toBe("NEEDS_RECONCILIATION");
  });

  it("checks persisted identity, checksum and bytes but never promotes the claim", async () => {
    const item = await seed();
    const key = `creator/${scope.workspaceId}/${scope.creatorProjectId}/renders/timeline-${scope.timelineId}/export-${item.exportId}_a0b1c2d3.mp4`;
    const [inserted] = await d.db.execute(sql`
      INSERT INTO creatorAssets (workspaceId, creatorProjectId, assetType,
        mimeType, storageKey, checksumSha256, byteSize, immutable,
        provenanceJson, reviewDecision)
      VALUES (${scope.workspaceId}, ${scope.creatorProjectId}, 'RENDER',
        'video/mp4', ${key}, ${digest}, 4, 1, '{}', 'PENDING')
    `);
    const assetId = Number((inserted as { insertId?: number }).insertId);
    await d.db.execute(sql`
      UPDATE creatorExports SET assetId = ${assetId}, checksumSha256 = ${digest}
      WHERE id = ${item.exportId}
    `);
    await d.db.execute(sql`
      UPDATE creatorRenderClaims SET outputAssetId = ${assetId},
        outputChecksumSha256 = ${digest} WHERE id = ${item.claimId}
    `);
    const verify = vi.fn(async () => undefined);
    const deps = {
      dbProvider: async () => d.db,
      listObjects: async () => [{ key, sizeBytes: 4 }],
      verify,
    };
    const valid = await inspectQuarantinedCreatorRender(item, deps);
    expect(valid).toMatchObject({
      outcome: "VERIFIED_BUT_QUARANTINED", verifiedAssetId: assetId,
      autoRetry: false, finalMaster: false, publishApproved: false,
    });
    expect(verify).toHaveBeenCalledWith(key, 4, digest);
    // Persisted asset metadata without any listed object is a storage/DB
    // inconsistency, not the benign absence of an unfinalized orphan.
    const missingPersisted = await inspectQuarantinedCreatorRender(item, {
      ...deps, listObjects: async () => [],
    });
    expect(missingPersisted).toMatchObject({
      outcome: "METADATA_DRIFT", observedObjects: 0,
      verifiedAssetId: null, autoRetry: false,
    });
    const [rows] = await d.db.execute(sql`
      SELECT state FROM creatorRenderClaims WHERE id = ${item.claimId}
    `) as unknown as [[{ state: string }]];
    expect(rows[0].state).toBe("NEEDS_RECONCILIATION");
    const mismatch = await inspectQuarantinedCreatorRender(item, {
      ...deps, listObjects: async () => [{ key, sizeBytes: 5 }],
    });
    expect(mismatch.outcome).toBe("METADATA_DRIFT");
    const unreadable = await inspectQuarantinedCreatorRender(item, {
      ...deps, verify: async () => { throw new Error("private S3 credential detail"); },
    });
    expect(unreadable.outcome).toBe("STORED_BYTES_UNVERIFIED");
    expect(JSON.stringify(unreadable)).not.toContain("credential");
  });

  it("fails closed on cross-tenant identity and inaccessible storage", async () => {
    const item = await seed();
    await expect(inspectQuarantinedCreatorRender({ ...item, workspaceId: 994 }, {
      dbProvider: async () => d.db,
    })).rejects.toThrow("CREATOR_RENDER_RECONCILIATION_CLAIM_NOT_FOUND");
    const result = await inspectQuarantinedCreatorRender(item, {
      dbProvider: async () => d.db,
      listObjects: async () => { throw new Error("S3 unavailable: private credentials"); },
    });
    expect(result.outcome).toBe("STORAGE_UNAVAILABLE");
    expect(JSON.stringify(result)).not.toContain("credentials");
  });
});
