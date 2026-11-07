import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { auditCreatorStoragePage } from "./orphanReconciliation";
import type { CreatorObject } from "./orphanInventoryPolicy";

const payload = Buffer.from("Murugan approved media");
const sha = createHash("sha256").update(payload).digest("hex");
const key = "creator/7/10/audio-master/master.wav";
const page = (objects: CreatorObject[] = [{ key, sizeBytes: payload.length, lastModified: new Date("2026-11-07T00:00:00Z") }], isTruncated = false, nextContinuationToken?: string) =>
  ({ objects, isTruncated, nextContinuationToken });
const reference = () => [{ assetId: 33, storageKey: key, checksumSha256: sha, byteSize: payload.length }];

describe("Creator bounded read-only object reconciliation", () => {
  it("verifies a referenced object using actual bytes and SHA-256", async () => {
    const result = await auditCreatorStoragePage({ workspaceId: 7 }, {
      list: async () => page(), loadReferences: async () => reference(), read: async () => payload,
    });
    expect(result.entries[0].checksum).toBe("MATCH");
    expect(result.deletionPerformed).toBe(false);
    expect(result.checksumReadsAttempted).toBe(1);
  });
  it("flags checksum corruption without deleting anything", async () => {
    const result = await auditCreatorStoragePage({ workspaceId: 7 }, {
      list: async () => page(), loadReferences: async () => reference(), read: async () => Buffer.from("wrong"),
    });
    expect(result.entries[0].checksum).toBe("MISMATCH");
    expect(result.deletionPerformed).toBe(false);
  });
  it("does not claim an unreferenced object is safe to delete", async () => {
    const result = await auditCreatorStoragePage({ workspaceId: 7, verifyChecksumCount: 0 }, {
      list: async () => page(), loadReferences: async () => [], now: () => Date.parse("2026-11-09T01:00:00Z"),
    });
    expect(result.entries[0].classification).toBe("UNREFERENCED_CANDIDATE");
    expect(result.deletionPerformed).toBe(false);
  });
  it("aborts rather than misclassifying objects if DB lookup fails", async () => {
    await expect(auditCreatorStoragePage({ workspaceId: 7 }, {
      list: async () => page(), loadReferences: async () => { throw new Error("DB unavailable"); },
    })).rejects.toThrow("DB unavailable");
  });
  it("rejects out-of-scope keys returned by a storage backend", async () => {
    await expect(auditCreatorStoragePage({ workspaceId: 7 }, {
      list: async () => page([{ key: "creator/8/other", sizeBytes: 1, lastModified: null }]),
      loadReferences: async () => [],
    })).rejects.toThrow("CREATOR_INVENTORY_SCOPE_VIOLATION");
  });
  it("enforces bounded pages and fails closed on a missing continuation token", async () => {
    await expect(auditCreatorStoragePage({ workspaceId: 7 }, {
      list: async () => page(undefined, true), loadReferences: async () => [],
    })).rejects.toThrow("CREATOR_INVENTORY_INVALID_PAGE");
    await expect(auditCreatorStoragePage({ workspaceId: 7, maxKeys: 201 }, {
      list: async () => page(), loadReferences: async () => [],
    })).rejects.toThrow("CREATOR_INVENTORY_LIMIT_INVALID");
  });
  it("returns pagination token but never mutates storage", async () => {
    const result = await auditCreatorStoragePage({ workspaceId: 7, verifyChecksumCount: 0 }, {
      list: async () => page(undefined, true, "next-token"), loadReferences: async () => [],
    });
    expect(result.hasMore).toBe(true);
    expect(result.nextContinuationToken).toBe("next-token");
    expect(result.deletionPerformed).toBe(false);
  });
  it("passes inventoried byte size into the bounded ranged read", async () => {
    let requestedSize = -1;
    const result = await auditCreatorStoragePage({ workspaceId: 7 }, {
      list: async () => page(),
      loadReferences: async () => reference(),
      read: async (_key, expectedSize) => {
        requestedSize = expectedSize;
        return payload;
      },
    });
    expect(requestedSize).toBe(payload.length);
    expect(result.entries[0].checksum).toBe("MATCH");
  });
  it("fails closed if a ranged read detects post-list object growth", async () => {
    const result = await auditCreatorStoragePage({ workspaceId: 7 }, {
      list: async () => page(),
      loadReferences: async () => reference(),
      read: async () => { throw new Error("CREATOR_CHECKSUM_RANGE_NOT_HONORED"); },
    });
    expect(result.entries[0].checksum).toBe("READ_FAILED");
    expect(result.deletionPerformed).toBe(false);
  });
  it("records a failed checksum read rather than claiming verification", async () => {
    const result = await auditCreatorStoragePage({ workspaceId: 7 }, {
      list: async () => page(), loadReferences: async () => reference(), read: async () => { throw new Error("storage read failed"); },
    });
    expect(result.entries[0].checksum).toBe("READ_FAILED");
  });
});
