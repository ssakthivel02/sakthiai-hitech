import { sql } from "drizzle-orm";
import { getDb } from "../db";
import { storageListCreatorRenderObjects, storageVerifySha256 } from "../storage";
import { assertCreatorRenderStorageKey, type CreatorRenderStorageIdentity } from "./renderStorageKey";

/**
 * Read-only operator evidence for ONE quarantined Creator render.
 *
 * This intentionally cannot resume, approve, delete or promote anything.
 * An uploaded orphan without a trusted persisted SHA-256 + byte count cannot
 * be certified, even if S3 reports that the object exists.
 */
export type CreatorRenderReconciliationScope = CreatorRenderStorageIdentity & {
  claimId: number;
};
export type CreatorRenderReconciliationResult = {
  claimId: number;
  exportId: number;
  outcome:
    | "CANCELLED_BEFORE_DISPATCH"
    | "NO_OBJECT_OBSERVED"
    | "UNVERIFIED_ORPHAN"
    | "VERIFIED_BUT_QUARANTINED"
    | "METADATA_DRIFT"
    | "STORAGE_UNAVAILABLE"
    | "STORED_BYTES_UNVERIFIED";
  observedObjects: number;
  verifiedAssetId: number | null;
  /** Always false: explicit owner review is required after reconciliation. */
  autoRetry: false;
  finalMaster: false;
  publishApproved: false;
};

type ReconciliationRow = {
  claimId: number;
  exportId: number;
  fingerprint: string;
  exportStatus: string;
  exportAssetId: number | null;
  exportChecksum: string | null;
  claimAssetId: number | null;
  claimChecksum: string | null;
  assetId: number | null;
  assetType: string | null;
  assetImmutable: number | null;
  assetKey: string | null;
  assetSize: number | null;
  assetChecksum: string | null;
};

export type CreatorRenderReconciliationDependencies = {
  dbProvider?: typeof getDb;
  listObjects?: typeof storageListCreatorRenderObjects;
  verify?: typeof storageVerifySha256;
};

function positive(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}
function sha(value: string | null): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

export async function inspectQuarantinedCreatorRender(
  scope: CreatorRenderReconciliationScope,
  deps: CreatorRenderReconciliationDependencies = {},
): Promise<CreatorRenderReconciliationResult> {
  if (![scope.workspaceId, scope.creatorProjectId, scope.timelineId, scope.exportId, scope.claimId].every(positive)) {
    throw new Error("CREATOR_RENDER_RECONCILIATION_SCOPE_INVALID");
  }
  const db = await (deps.dbProvider ?? getDb)();
  if (!db) throw new Error("CREATOR_RENDER_RECONCILIATION_DATABASE_UNAVAILABLE");
  const result = await db.execute(sql`
    SELECT c.id AS claimId, c.exportId, c.fingerprint,
      e.status AS exportStatus, e.assetId AS exportAssetId,
      e.checksumSha256 AS exportChecksum,
      c.outputAssetId AS claimAssetId, c.outputChecksumSha256 AS claimChecksum,
      a.id AS assetId, a.assetType, a.immutable AS assetImmutable,
      a.storageKey AS assetKey, a.byteSize AS assetSize, a.checksumSha256 AS assetChecksum
    FROM creatorRenderClaims c
    INNER JOIN creatorExports e ON e.id = c.exportId
      AND e.workspaceId = c.workspaceId
      AND e.creatorProjectId = c.creatorProjectId
      AND e.timelineId = c.timelineId
    LEFT JOIN creatorAssets a ON a.id = e.assetId
      AND a.workspaceId = c.workspaceId
      AND a.creatorProjectId = c.creatorProjectId
    WHERE c.id = ${scope.claimId} AND c.workspaceId = ${scope.workspaceId}
      AND c.creatorProjectId = ${scope.creatorProjectId}
      AND c.timelineId = ${scope.timelineId}
      AND c.exportId = ${scope.exportId}
      AND c.state = 'NEEDS_RECONCILIATION'
    LIMIT 1
  `);
  const rows = Array.isArray(result) && Array.isArray(result[0])
    ? result[0] as ReconciliationRow[] : [];
  const row = rows[0];
  if (!row) throw new Error("CREATOR_RENDER_RECONCILIATION_CLAIM_NOT_FOUND");
  if (!sha(row.fingerprint)) throw new Error("CREATOR_RENDER_RECONCILIATION_FINGERPRINT_INVALID");
  const report = (
    outcome: CreatorRenderReconciliationResult["outcome"],
    observedObjects: number,
    verifiedAssetId: number | null = null,
  ): CreatorRenderReconciliationResult => ({
    claimId: scope.claimId, exportId: scope.exportId, outcome,
    observedObjects, verifiedAssetId, autoRetry: false,
    finalMaster: false, publishApproved: false,
  });

  // A queued export cancelled before acquisition cannot have generated
  // output through the fenced worker. Never scan or revive it.
  if (row.exportStatus === "CANCELLED") return report("CANCELLED_BEFORE_DISPATCH", 0);

  let objects: Array<{ key: string; sizeBytes: number }>;
  try {
    objects = await (deps.listObjects ?? storageListCreatorRenderObjects)(scope);
    if (objects.length > 100 || objects.some(obj => {
      try {
        assertCreatorRenderStorageKey(obj.key, scope);
        return !Number.isSafeInteger(obj.sizeBytes) || obj.sizeBytes < 0;
      } catch { return true; }
    })) throw new Error("CREATOR_RENDER_RECONCILIATION_INVENTORY_INVALID");
  } catch {
    // No false negative when the S3 endpoint is unreachable or inventory is
    // truncated; retain quarantine and report only a safe error class.
    return report("STORAGE_UNAVAILABLE", 0);
  }

  if (objects.length === 0) {
    // A missing object with an already persisted asset/checksum is NOT the
    // same as an unfinalized export with no object. Surface the discrepancy
    // for manual investigation; never suggest that a previously finalized
    // render simply did not produce media.
    const hasPersistedEvidence =
      row.exportAssetId !== null || row.claimAssetId !== null ||
      row.assetId !== null || row.exportChecksum !== null ||
      row.claimChecksum !== null;
    return report(hasPersistedEvidence ? "METADATA_DRIFT" : "NO_OBJECT_OBSERVED", 0);
  }
  if (row.exportAssetId === null && row.claimAssetId === null &&
      row.assetId === null && row.exportChecksum === null &&
      row.claimChecksum === null) {
    return report("UNVERIFIED_ORPHAN", objects.length);
  }
  if (!positive(row.exportAssetId ?? 0) || row.assetId !== row.exportAssetId ||
      row.claimAssetId !== row.exportAssetId ||
      row.assetType !== "RENDER" || row.assetImmutable !== 1 ||
      !sha(row.assetChecksum) || !sha(row.exportChecksum) ||
      !sha(row.claimChecksum) ||
      row.assetChecksum !== row.exportChecksum ||
      row.assetChecksum !== row.claimChecksum ||
      !positive(row.assetSize ?? 0) || !row.assetKey) {
    return report("METADATA_DRIFT", objects.length);
  }
  try { assertCreatorRenderStorageKey(row.assetKey, scope); }
  catch { return report("METADATA_DRIFT", objects.length); }
  if (!objects.some(obj => obj.key === row.assetKey && obj.sizeBytes === row.assetSize)) {
    return report("METADATA_DRIFT", objects.length);
  }
  try {
    await (deps.verify ?? storageVerifySha256)(row.assetKey, row.assetSize!, row.assetChecksum!);
  } catch {
    return report("STORED_BYTES_UNVERIFIED", objects.length);
  }
  return report("VERIFIED_BUT_QUARANTINED", objects.length, row.assetId);
}
