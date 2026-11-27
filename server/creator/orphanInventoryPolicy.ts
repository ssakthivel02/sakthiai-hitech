/** Read-only Creator storage inventory policy. A missing DB row is only a candidate,
 * never permission to delete an object: uploads may be in flight or commits uncertain. */
export type CreatorObject = {
  key: string;
  sizeBytes: number;
  lastModified: Date | null;
};

export type CreatorAssetReference = {
  assetId: number;
  storageKey: string;
  checksumSha256: string;
  byteSize: number | null;
};

export type CreatorInventoryEntry = {
  key: string;
  sizeBytes: number;
  lastModified: string | null;
  classification: "REFERENCED" | "UNREFERENCED_RECENT" | "UNREFERENCED_CANDIDATE" | "UNREFERENCED_AGE_UNKNOWN";
  referenceAssetIds: number[];
  expectedSha256: string | null;
  checksum: "NOT_APPLICABLE" | "NOT_CHECKED" | "INVALID_EXPECTED_CHECKSUM" | "SIZE_MISMATCH" | "MATCH" | "MISMATCH" | "READ_FAILED";
};

export const CREATOR_ORPHAN_MIN_AGE_MS = 24 * 60 * 60 * 1000;

export function classifyCreatorInventory(
  objects: readonly CreatorObject[],
  references: readonly CreatorAssetReference[],
  nowMs: number,
  minAgeMs = CREATOR_ORPHAN_MIN_AGE_MS,
): CreatorInventoryEntry[] {
  if (!Number.isFinite(nowMs) || !Number.isFinite(minAgeMs) || minAgeMs < 0) {
    throw new Error("CREATOR_INVENTORY_INVALID_CLOCK");
  }
  const byKey = new Map<string, CreatorAssetReference[]>();
  for (const reference of references) {
    const group = byKey.get(reference.storageKey) ?? [];
    group.push(reference);
    byKey.set(reference.storageKey, group);
  }
  const seen = new Set<string>();
  return objects.map((object) => {
    if (!object.key || seen.has(object.key) || !Number.isSafeInteger(object.sizeBytes) || object.sizeBytes < 0) {
      throw new Error("CREATOR_INVENTORY_INVALID_OBJECT");
    }
    seen.add(object.key);
    const refs = byKey.get(object.key) ?? [];
    const lastModifiedMs = object.lastModified?.getTime();
    const validDate = lastModifiedMs !== undefined && Number.isFinite(lastModifiedMs);
    const lastModified = validDate ? object.lastModified!.toISOString() : null;
    if (refs.length === 0) {
      const classification = !validDate || lastModifiedMs! > nowMs
        ? "UNREFERENCED_AGE_UNKNOWN"
        : nowMs - lastModifiedMs! < minAgeMs
          ? "UNREFERENCED_RECENT"
          : "UNREFERENCED_CANDIDATE";
      return { key: object.key, sizeBytes: object.sizeBytes, lastModified, classification,
        referenceAssetIds: [], expectedSha256: null, checksum: "NOT_APPLICABLE" };
    }
    const expected = refs[0].checksumSha256.toLowerCase();
    const invalidChecksum = refs.some((r) => !/^[a-f0-9]{64}$/i.test(r.checksumSha256) || r.checksumSha256.toLowerCase() !== expected);
    const sizeMismatch = refs.some((r) => r.byteSize !== null && r.byteSize !== object.sizeBytes);
    return { key: object.key, sizeBytes: object.sizeBytes, lastModified,
      classification: "REFERENCED", referenceAssetIds: refs.map((r) => r.assetId),
      expectedSha256: invalidChecksum ? null : expected,
      checksum: invalidChecksum ? "INVALID_EXPECTED_CHECKSUM" : sizeMismatch ? "SIZE_MISMATCH" : "NOT_CHECKED" };
  });
}
