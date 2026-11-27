import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { classifyCreatorStagedArtifact, parseCreatorStagedKey, type StagedArtifactEvidence } from "./stagedArtifactInventory";

const provider = "google-veo";
const providerJobId = "veo-job-1";
const checksum = "a".repeat(64);
const jobHash = createHash("sha256").update(provider).update("\0").update(providerJobId).digest("hex").slice(0, 32);
const key = `creator/7/9/staged/generation-11/job-${jobHash}/${checksum}.mp4`;
const now = Date.parse("2026-11-11T01:00:00Z");
function evidence(): StagedArtifactEvidence {
  return {
    object: { key, sizeBytes: 8 }, nowMs: now,
    generation: { id: 11, workspaceId: 7, creatorProjectId: 9, provider, status: "RUNNING", outputAssetId: null },
    latestJob: { workspaceId: 7, creatorProjectId: 9, generationId: 11, provider, providerJobId, status: "SUCCEEDED" },
    lease: { workspaceId: 7, creatorProjectId: 9, generationId: 11, providerJobId,
      leaseUntil: new Date(now - 1000), stagedStorageKey: key, stagedChecksumSha256: checksum,
      stagedByteSize: 8, stagedMimeType: "video/mp4" },
    assets: [], verified: "PASS",
  };
}

describe("read-only staged artifact inventory classification", () => {
  it("recognizes only canonical tenant-scoped staged identities", () => {
    expect(parseCreatorStagedKey(key)?.generationId).toBe(11);
    expect(parseCreatorStagedKey(key.replace("creator/7/", "creator/07/"))).toBeNull();
    expect(parseCreatorStagedKey(key.replace("generation-11", "generation-99999999999999999999"))).toBeNull();
    expect(parseCreatorStagedKey(key + "/extra")).toBeNull();
  });
  it("reports verified expired stage as recoverable without mutating it", () => {
    expect(classifyCreatorStagedArtifact(evidence())).toBe("RECOVERABLE_STAGE");
  });
  it("does not attempt recovery while a live upload lease exists", () => {
    const e = evidence(); e.lease!.leaseUntil = new Date(now + 10_000);
    e.verified = "NOT_CHECKED";
    expect(classifyCreatorStagedArtifact(e)).toBe("ACTIVE_UPLOAD");
  });
  it("rejects a superseded provider job", () => {
    const e = evidence(); e.latestJob!.providerJobId = "different";
    expect(classifyCreatorStagedArtifact(e)).toBe("OWNERSHIP_CONFLICT");
  });
  it("rejects tenant and stage checksum mismatches", () => {
    const e = evidence(); e.lease!.workspaceId = 8;
    expect(classifyCreatorStagedArtifact(e)).toBe("OWNERSHIP_CONFLICT");
    const f = evidence(); f.lease!.stagedChecksumSha256 = "b".repeat(64);
    expect(classifyCreatorStagedArtifact(f)).toBe("OWNERSHIP_CONFLICT");
  });
  it("flags unreferenced storage as a candidate, not safe to delete", () => {
    const e = evidence(); e.lease = null;
    expect(classifyCreatorStagedArtifact(e)).toBe("UNREFERENCED_CANDIDATE");
  });
  it("accepts only verified, committed generation output assets", () => {
    const e = evidence(); e.lease = null; e.generation!.status = "SUCCEEDED"; e.generation!.outputAssetId = 44;
    e.assets = [{ id: 44, workspaceId: 7, creatorProjectId: 9, storageKey: key, checksumSha256: checksum, byteSize: 8 }];
    expect(classifyCreatorStagedArtifact(e)).toBe("REFERENCED_ASSET");
    e.verified = "FAIL";
    expect(classifyCreatorStagedArtifact(e)).toBe("STORAGE_UNVERIFIED");
    e.assets[0].workspaceId = 8;
    expect(classifyCreatorStagedArtifact(e)).toBe("OWNERSHIP_CONFLICT");
  });
  it("refuses corrupt, incomplete, or cancelled-stage evidence", () => {
    const e = evidence(); e.verified = "FAIL";
    expect(classifyCreatorStagedArtifact(e)).toBe("STORAGE_UNVERIFIED");
    const f = evidence(); f.generation!.status = "CANCELLED";
    expect(classifyCreatorStagedArtifact(f)).toBe("OWNERSHIP_CONFLICT");
    const g = evidence(); g.lease!.stagedMimeType = null;
    expect(classifyCreatorStagedArtifact(g)).toBe("OWNERSHIP_CONFLICT");
  });
});
