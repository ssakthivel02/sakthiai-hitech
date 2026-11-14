import { describe, expect, it } from "vitest";
import {
  assertGeneratedAssetReviewTarget,
  assertGeneratedReviewGeneration,
  assertGeneratedReviewProviderJob,
  type GeneratedAssetReviewTarget,
} from "./generatedAssetReviewPolicy";

const checksum = "a".repeat(64);
const asset = (): GeneratedAssetReviewTarget => ({
  id: 81, workspaceId: 7, creatorProjectId: 9, shotId: 3,
  assetType: "IMAGE", mimeType: "image/png", immutable: 1, reviewDecision: "PENDING",
  checksumSha256: checksum, byteSize: 1024, storageKey: "creator/7/9/staged/generation-12/job-" + "b".repeat(32) + "/" + checksum + ".png",
  provenanceJson: JSON.stringify({ schemaVersion: 1, creatorProjectId: 9, shotId: 3,
    generationId: 12, provider: "google", providerJobId: "provider-job-12", checksumSha256: checksum }),
});
const input = { workspaceId: 7, creatorProjectId: 9, assetId: 81, expectedChecksumSha256: checksum };
const generation = { id: 12, workspaceId: 7, creatorProjectId: 9, shotId: 3,
  outputAssetId: 81, provider: "google", status: "SUCCEEDED", kind: "IMAGE" };
const job = { workspaceId: 7, creatorProjectId: 9, generationId: 12,
  provider: "google", providerJobId: "provider-job-12", status: "SUCCEEDED" };

describe("generated IMAGE/VIDEO approval evidence policy", () => {
  it("accepts only a completed immutable scoped generation and provider job", () => {
    const target = asset();
    const identity = assertGeneratedAssetReviewTarget(target, input);
    expect(identity).toEqual({ generationId: 12, provider: "google", providerJobId: "provider-job-12" });
    expect(() => assertGeneratedReviewGeneration(generation, target, identity)).not.toThrow();
    expect(() => assertGeneratedReviewProviderJob(job, target, identity)).not.toThrow();
  });
  it("refuses a different workspace, project or expected checksum", () => {
    expect(() => assertGeneratedAssetReviewTarget(asset(), { ...input, workspaceId: 8 })).toThrow("CREATOR_GENERATED_REVIEW_ASSET_NOT_FOUND");
    expect(() => assertGeneratedAssetReviewTarget(asset(), { ...input, creatorProjectId: 10 })).toThrow("CREATOR_GENERATED_REVIEW_ASSET_NOT_FOUND");
    expect(() => assertGeneratedAssetReviewTarget(asset(), { ...input, expectedChecksumSha256: "f".repeat(64) })).toThrow("CREATOR_GENERATED_REVIEW_ARTIFACT_EVIDENCE_MISMATCH");
  });
  it("refuses already approved, rejected or mutable assets", () => {
    for (const update of [{ reviewDecision: "APPROVED" }, { reviewDecision: "REJECTED" }, { immutable: 0 }]) {
      expect(() => assertGeneratedAssetReviewTarget({ ...asset(), ...update }, input)).toThrow("CREATOR_GENERATED_REVIEW_ALREADY_DECIDED");
    }
  });
  it("refuses render, audio, unsupported mime and missing byte evidence", () => {
    for (const update of [{ assetType: "RENDER" }, { assetType: "AUDIO" }]) {
      expect(() => assertGeneratedAssetReviewTarget({ ...asset(), ...update }, input)).toThrow("CREATOR_GENERATED_REVIEW_TYPE_INVALID");
    }
    expect(() => assertGeneratedAssetReviewTarget({ ...asset(), mimeType: "text/html" }, input)).toThrow("CREATOR_GENERATED_REVIEW_MIME_INVALID");
    expect(() => assertGeneratedAssetReviewTarget({ ...asset(), byteSize: null }, input)).toThrow("CREATOR_GENERATED_REVIEW_ARTIFACT_EVIDENCE_MISMATCH");
  });
  it("refuses forged or malformed generation provenance", () => {
    expect(() => assertGeneratedAssetReviewTarget({ ...asset(), provenanceJson: "{}" }, input)).toThrow("CREATOR_GENERATED_REVIEW_PROVENANCE_INVALID");
    expect(() => assertGeneratedAssetReviewTarget({ ...asset(), provenanceJson: "bad-json" }, input)).toThrow("CREATOR_GENERATED_REVIEW_PROVENANCE_INVALID");
    const p = JSON.parse(asset().provenanceJson);
    expect(() => assertGeneratedAssetReviewTarget({ ...asset(), provenanceJson: JSON.stringify({ ...p, shotId: 99 }) }, input)).toThrow("CREATOR_GENERATED_REVIEW_PROVENANCE_INVALID");
  });
  it("refuses superseded, incomplete or mismatched provider jobs", () => {
    const identity = assertGeneratedAssetReviewTarget(asset(), input);
    for (const update of [{ providerJobId: "other" }, { status: "RUNNING" }, { workspaceId: 8 }]) {
      expect(() => assertGeneratedReviewProviderJob({ ...job, ...update }, asset(), identity)).toThrow("CREATOR_GENERATED_REVIEW_PROVIDER_JOB_MISMATCH");
    }
  });
  it("refuses generation output or status drift", () => {
    const identity = assertGeneratedAssetReviewTarget(asset(), input);
    for (const update of [{ outputAssetId: 99 }, { status: "RUNNING" }, { provider: "other" }, { shotId: 44 }]) {
      expect(() => assertGeneratedReviewGeneration({ ...generation, ...update }, asset(), identity)).toThrow("CREATOR_GENERATED_REVIEW_GENERATION_MISMATCH");
    }
  });
  it("accepts VIDEO/mp4 only with a video generation kind", () => {
    const target = { ...asset(), assetType: "VIDEO", mimeType: "video/mp4" };
    const identity = assertGeneratedAssetReviewTarget(target, input);
    expect(() => assertGeneratedReviewGeneration({ ...generation, kind: "VIDEO" }, target, identity)).not.toThrow();
    expect(() => assertGeneratedReviewGeneration(generation, target, identity)).toThrow("CREATOR_GENERATED_REVIEW_GENERATION_MISMATCH");
  });
});
