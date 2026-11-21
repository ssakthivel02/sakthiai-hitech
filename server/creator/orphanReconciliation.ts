import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { creatorAssets } from "../../drizzle/schema";
import { getDb } from "../db";
import { storageListPage, storageReadExactRange } from "../storage";
import { CREATOR_CHECKSUM_MAX_BYTES } from "./boundedObjectRead";
import { classifyCreatorInventory, type CreatorAssetReference, type CreatorObject } from "./orphanInventoryPolicy";

/** Bounded, read-only page. No object deletion, writes, or automatic orphan claims. */
export async function auditCreatorStoragePage(input: {
  workspaceId: number;
  continuationToken?: string;
  maxKeys?: number;
  verifyChecksumCount?: number;
}, deps: {
  list?: typeof storageListPage;
  loadReferences?: (workspaceId: number, keys: string[]) => Promise<CreatorAssetReference[]>;
  read?: typeof storageReadExactRange;
  now?: () => number;
} = {}) {
  if (!Number.isSafeInteger(input.workspaceId) || input.workspaceId <= 0) throw new Error("CREATOR_INVENTORY_INVALID_WORKSPACE");
  const maxKeys = input.maxKeys ?? 100;
  const verifyChecksumCount = input.verifyChecksumCount ?? 2;
  if (!Number.isInteger(maxKeys) || maxKeys < 1 || maxKeys > 200 ||
      !Number.isInteger(verifyChecksumCount) || verifyChecksumCount < 0 || verifyChecksumCount > 3) {
    throw new Error("CREATOR_INVENTORY_LIMIT_INVALID");
  }
  const prefix = `creator/${input.workspaceId}/`;
  const list = deps.list ?? storageListPage;
  const page = await list(prefix, maxKeys, input.continuationToken);
  if (page.objects.length > maxKeys || (page.isTruncated && !page.nextContinuationToken)) {
    throw new Error("CREATOR_INVENTORY_INVALID_PAGE");
  }
  if (page.objects.some((object: CreatorObject) => !object.key.startsWith(prefix))) {
    throw new Error("CREATOR_INVENTORY_SCOPE_VIOLATION");
  }
  const keys = page.objects.map((object: CreatorObject) => object.key);
  const loadReferences = deps.loadReferences ?? (async (workspaceId: number, storageKeys: string[]) => {
    const db = await getDb();
    if (!db) throw new Error("CREATOR_DATABASE_UNAVAILABLE");
    if (!storageKeys.length) return [];
    return db.select({ assetId: creatorAssets.id, storageKey: creatorAssets.storageKey,
      checksumSha256: creatorAssets.checksumSha256, byteSize: creatorAssets.byteSize })
      .from(creatorAssets)
      .where(and(eq(creatorAssets.workspaceId, workspaceId), inArray(creatorAssets.storageKey, storageKeys)));
  });
  // Any DB failure aborts the audit. Never classify objects as unreferenced on partial DB evidence.
  const references = await loadReferences(input.workspaceId, keys);
  if (references.some((r) => !keys.includes(r.storageKey))) throw new Error("CREATOR_INVENTORY_REFERENCE_SCOPE_VIOLATION");
  const entries = classifyCreatorInventory(page.objects, references, (deps.now ?? Date.now)());
  const read = deps.read ?? storageReadExactRange;
  let verified = 0;
  for (const entry of entries) {
    if (verified >= verifyChecksumCount) break;
    if (entry.classification !== "REFERENCED" || entry.checksum !== "NOT_CHECKED" ||
        entry.sizeBytes < 1 || entry.sizeBytes > CREATOR_CHECKSUM_MAX_BYTES || !entry.expectedSha256) continue;
    verified++;
    try {
      const bytes = Buffer.from(await read(entry.key, entry.sizeBytes));
      const actual = createHash("sha256").update(bytes).digest("hex");
      entry.checksum = bytes.byteLength === entry.sizeBytes && actual === entry.expectedSha256 ? "MATCH" : "MISMATCH";
    } catch {
      entry.checksum = "READ_FAILED";
    }
  }
  return {
    workspaceId: input.workspaceId,
    prefix,
    entries,
    scannedCount: entries.length,
    checksumReadsAttempted: verified,
    hasMore: page.isTruncated,
    nextContinuationToken: page.nextContinuationToken,
    deletionPerformed: false as const,
    note: "UNREFERENCED_CANDIDATE is not proof of orphanhood. Uploads may be in flight; never delete automatically.",
  };
}
