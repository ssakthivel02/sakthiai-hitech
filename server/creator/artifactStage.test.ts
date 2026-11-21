import { describe, expect, it } from "vitest";
import { assertCreatorStagedArtifactMatches, creatorArtifactStageKey } from "./artifactStage";
const base = { workspaceId: 12, creatorProjectId: 34, generationId: 56,
  provider: "google-veo", providerJobId: "opaque-secret-id",
  checksumSha256: "a".repeat(64), extension: "mp4" };
describe("durable Creator stage identity", () => {
  it("derives deterministic tenant-scoped paths without exposing provider IDs", () => {
    const key = creatorArtifactStageKey(base);
    expect(key).toMatch(/^creator\/12\/34\/staged\/generation-56\/job-[a-f0-9]{32}\/[a-f0-9]{64}\.mp4$/);
    expect(key).not.toContain(base.providerJobId);
    expect(creatorArtifactStageKey(base)).toBe(key);
    expect(creatorArtifactStageKey({ ...base, workspaceId: 13 })).not.toBe(key);
  });
  it("rejects invalid scope and path injection", () => {
    expect(() => creatorArtifactStageKey({ ...base, generationId: 0 })).toThrow("CREATOR_ARTIFACT_STAGE_SCOPE_INVALID");
    expect(() => creatorArtifactStageKey({ ...base, extension: "../mp4" })).toThrow("CREATOR_ARTIFACT_STAGE_IDENTITY_INVALID");
  });
  it("rejects changed checksum, MIME and size during retry", () => {
    const a = { storageKey: creatorArtifactStageKey(base), checksumSha256: base.checksumSha256, byteSize: 100, mimeType: "video/mp4" };
    expect(() => assertCreatorStagedArtifactMatches(a, { ...a })).not.toThrow();
    for (const b of [{ ...a, byteSize: 101 }, { ...a, mimeType: "image/png" }, { ...a, checksumSha256: "b".repeat(64) }])
      expect(() => assertCreatorStagedArtifactMatches(a, b)).toThrow("CREATOR_ARTIFACT_STAGE_IDENTITY_CHANGED");
  });
});
