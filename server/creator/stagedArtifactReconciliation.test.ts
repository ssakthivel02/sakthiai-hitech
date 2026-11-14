import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { inspectCreatorStagedInventory } from "./stagedArtifactReconciliation";

const provider = "google-veo";
const jobId = "job-9";
const hash = createHash("sha256").update(provider).update("\0").update(jobId).digest("hex").slice(0, 32);
const checksum = "b".repeat(64);
const key = `creator/5/6/staged/generation-7/job-${hash}/${checksum}.mp4`;
const nowMs = Date.parse("2026-11-11T01:00:00Z");
const evidence = () => ({
  generation: { id: 7, workspaceId: 5, creatorProjectId: 6, provider, status: "RUNNING", outputAssetId: null },
  latestJob: { workspaceId: 5, creatorProjectId: 6, generationId: 7, provider, providerJobId: jobId, status: "SUCCEEDED" },
  lease: { workspaceId: 5, creatorProjectId: 6, generationId: 7, providerJobId: jobId,
    leaseUntil: new Date(nowMs - 1), stagedStorageKey: key,
    stagedChecksumSha256: checksum, stagedByteSize: 12, stagedMimeType: "video/mp4" },
  assets: [],
});

describe("bounded read-only staged artifact reconciliation", () => {
  it("verifies recoverable expired staged bytes without any writes", async () => {
    const list = vi.fn(async () => ({ objects: [{ key, sizeBytes: 12, lastModified: null }], isTruncated: false }));
    const load = vi.fn(async () => evidence());
    const verify = vi.fn(async () => undefined);
    const result = await inspectCreatorStagedInventory({ workspaceId: 5, nowMs }, { list, load, verify });
    expect(result.findings).toEqual([{ key, sizeBytes: 12, finding: "RECOVERABLE_STAGE" }]);
    expect(result.complete).toBe(true);
    expect(verify).toHaveBeenCalledOnce();
    expect(list).toHaveBeenCalledWith("creator/5/", 100, undefined);
  });
  it("never marks an incomplete page as complete", async () => {
    const list = vi.fn(async () => ({ objects: [{ key: "creator/5/other/file", sizeBytes: 1, lastModified: null }],
      isTruncated: true, nextContinuationToken: "next" }));
    const result = await inspectCreatorStagedInventory({ workspaceId: 5, maxKeys: 1 }, {
      list, load: vi.fn(async () => evidence()), verify: vi.fn(async () => undefined),
    });
    expect(result).toMatchObject({ complete: false, nextContinuationToken: "next", skippedNonStaged: 1, findings: [] });
  });
  it("never verifies an actively leased upload", async () => {
    const active = evidence(); active.lease.leaseUntil = new Date(nowMs + 60_000);
    const verify = vi.fn(async () => undefined);
    const result = await inspectCreatorStagedInventory({ workspaceId: 5, nowMs }, {
      list: async () => ({ objects: [{ key, sizeBytes: 12, lastModified: null }], isTruncated: false }),
      load: async () => active, verify,
    });
    expect(result.findings[0].finding).toBe("ACTIVE_UPLOAD");
    expect(verify).not.toHaveBeenCalled();
  });
  it("fails closed on corrupt storage and cross-tenant S3 results", async () => {
    const result = await inspectCreatorStagedInventory({ workspaceId: 5, nowMs }, {
      list: async () => ({ objects: [{ key, sizeBytes: 12, lastModified: null }], isTruncated: false }),
      load: async () => evidence(), verify: async () => { throw new Error("bad checksum"); },
    });
    expect(result.findings[0].finding).toBe("STORAGE_UNVERIFIED");
    await expect(inspectCreatorStagedInventory({ workspaceId: 5 }, {
      list: async () => ({ objects: [{ key: "creator/6/staged/fake", sizeBytes: 12, lastModified: null }], isTruncated: false }),
      load: async () => evidence(), verify: async () => undefined,
    })).rejects.toThrow("CREATOR_INVENTORY_STORAGE_SCOPE_MISMATCH");
  });
  it("refuses unbounded scans or malformed continuation", async () => {
    const deps = { list: vi.fn(), load: vi.fn(), verify: vi.fn() };
    await expect(inspectCreatorStagedInventory({ workspaceId: 0 }, deps)).rejects.toThrow("CREATOR_INVENTORY_WORKSPACE_INVALID");
    await expect(inspectCreatorStagedInventory({ workspaceId: 5, maxKeys: 201 }, deps)).rejects.toThrow("CREATOR_INVENTORY_LIMIT_INVALID");
    await expect(inspectCreatorStagedInventory({ workspaceId: 5, continuationToken: "" }, deps)).rejects.toThrow("CREATOR_INVENTORY_CURSOR_INVALID");
  });
});
