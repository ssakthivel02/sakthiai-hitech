import { describe, expect, it } from "vitest";
import { assertCreatorArtifactJobOwnership, isCreatorArtifactJobOwnershipError } from "./artifactJobOwnership";

const job = { workspaceId: 1, creatorProjectId: 2, generationId: 3, provider: "google-veo", providerJobId: "job-3", status: "SUCCEEDED" };
const expected = { workspaceId: 1, creatorProjectId: 2, generationId: 3, provider: "google-veo", providerJobId: "job-3", job };

describe("Creator artifact provider-job ownership", () => {
  it("accepts exact completed provider job", () => {
    expect(() => assertCreatorArtifactJobOwnership(expected)).not.toThrow();
  });
  it.each([
    ["workspace", { workspaceId: 99 }],
    ["project", { creatorProjectId: 99 }],
    ["generation", { generationId: 99 }],
    ["provider", { provider: "other" }],
    ["job ID", { providerJobId: "older" }],
  ])("rejects mismatched %s", (_name, override) => {
    expect(() => assertCreatorArtifactJobOwnership({ ...expected, job: { ...job, ...override } }))
      .toThrow("CREATOR_ARTIFACT_PROVIDER_JOB_MISMATCH");
  });
  it("rejects missing or blank job", () => {
    expect(() => assertCreatorArtifactJobOwnership({ ...expected, job: null }))
      .toThrow("CREATOR_ARTIFACT_PROVIDER_JOB_MISMATCH");
    expect(() => assertCreatorArtifactJobOwnership({ ...expected, providerJobId: "" }))
      .toThrow("CREATOR_ARTIFACT_PROVIDER_JOB_MISMATCH");
  });
  it("rejects unfinished job", () => {
    expect(() => assertCreatorArtifactJobOwnership({ ...expected, job: { ...job, status: "RUNNING" } }))
      .toThrow("CREATOR_ARTIFACT_PROVIDER_JOB_NOT_SUCCEEDED");
  });
  it("distinguishes ownership failures from network errors", () => {
    expect(isCreatorArtifactJobOwnershipError(new Error("CREATOR_ARTIFACT_PROVIDER_JOB_MISMATCH"))).toBe(true);
    expect(isCreatorArtifactJobOwnershipError(new Error("CREATOR_ARTIFACT_PROVIDER_JOB_NOT_SUCCEEDED"))).toBe(true);
    expect(isCreatorArtifactJobOwnershipError(new Error("NETWORK"))).toBe(false);
  });
});
