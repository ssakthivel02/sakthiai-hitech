import { describe, expect, it } from "vitest";
import { classifyCreatorInventory, CREATOR_ORPHAN_MIN_AGE_MS } from "./orphanInventoryPolicy";

const now = Date.parse("2026-11-08T00:00:00.000Z");
const object = (key: string, ageMs: number | null, sizeBytes = 3) => ({
  key, sizeBytes, lastModified: ageMs === null ? null : new Date(now - ageMs),
});
const reference = (key: string, sha = "a".repeat(64), byteSize: number | null = 3) => ({
  assetId: 9, storageKey: key, checksumSha256: sha, byteSize,
});

describe("Creator read-only orphan inventory policy", () => {
  it("does not mistake a recent upload for a safe-to-delete orphan", () => {
    const [entry] = classifyCreatorInventory([object("creator/1/recent", 1000)], [], now);
    expect(entry.classification).toBe("UNREFERENCED_RECENT");
  });
  it("only marks older unreferenced objects as candidates, never confirmed orphans", () => {
    const [entry] = classifyCreatorInventory([object("creator/1/old", CREATOR_ORPHAN_MIN_AGE_MS + 1)], [], now);
    expect(entry.classification).toBe("UNREFERENCED_CANDIDATE");
    expect(entry.checksum).toBe("NOT_APPLICABLE");
  });
  it("treats unknown and future modification timestamps as age unknown", () => {
    const entries = classifyCreatorInventory([object("creator/1/unknown", null), object("creator/1/future", -1000)], [], now);
    expect(entries.map((x) => x.classification)).toEqual(["UNREFERENCED_AGE_UNKNOWN", "UNREFERENCED_AGE_UNKNOWN"]);
  });
  it("retains DB references regardless of object age", () => {
    const [entry] = classifyCreatorInventory([object("creator/1/old", CREATOR_ORPHAN_MIN_AGE_MS * 2)], [reference("creator/1/old")], now);
    expect(entry.classification).toBe("REFERENCED");
    expect(entry.referenceAssetIds).toEqual([9]);
    expect(entry.checksum).toBe("NOT_CHECKED");
  });
  it("reports size disagreement before checksum reads", () => {
    const [entry] = classifyCreatorInventory([object("creator/1/asset", 1000)], [reference("creator/1/asset", "a".repeat(64), 4)], now);
    expect(entry.checksum).toBe("SIZE_MISMATCH");
  });
  it("rejects malformed and contradictory DB checksums", () => {
    const [invalid] = classifyCreatorInventory([object("creator/1/asset", 1000)], [reference("creator/1/asset", "oops")], now);
    expect(invalid.checksum).toBe("INVALID_EXPECTED_CHECKSUM");
    const [conflict] = classifyCreatorInventory([object("creator/1/asset", 1000)], [reference("creator/1/asset"), { ...reference("creator/1/asset", "b".repeat(64)), assetId: 10 }], now);
    expect(conflict.checksum).toBe("INVALID_EXPECTED_CHECKSUM");
    expect(conflict.referenceAssetIds).toEqual([9, 10]);
  });
  it("rejects duplicate inventory keys and invalid sizes", () => {
    expect(() => classifyCreatorInventory([object("creator/1/a", 1), object("creator/1/a", 2)], [], now)).toThrow("CREATOR_INVENTORY_INVALID_OBJECT");
    expect(() => classifyCreatorInventory([object("creator/1/a", 1, -1)], [], now)).toThrow("CREATOR_INVENTORY_INVALID_OBJECT");
  });
  it("rejects invalid clocks rather than aging objects unsafely", () => {
    expect(() => classifyCreatorInventory([object("creator/1/a", 1)], [], Number.NaN)).toThrow("CREATOR_INVENTORY_INVALID_CLOCK");
  });
});
