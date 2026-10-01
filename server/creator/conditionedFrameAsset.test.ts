import { describe, expect, it } from "vitest";
import { validateConditionedFrameAsset, type ConditionedFrameAssetRow } from "./conditionedFrameAsset";

const approved: ConditionedFrameAssetRow = {
  id: 41,
  workspaceId: 2,
  creatorProjectId: 7,
  assetType: "IMAGE",
  mimeType: "image/png",
  storageKey: "creator/2/7/41.png",
  immutable: 1,
  reviewDecision: "APPROVED",
};

const scope = { workspaceId: 2, creatorProjectId: 7, assetId: 41 };

describe("validateConditionedFrameAsset", () => {
  it("accepts approved immutable project-owned image assets", () => {
    expect(validateConditionedFrameAsset(approved, scope).id).toBe(41);
  });

  it("accepts approved immutable reference-image assets", () => {
    expect(validateConditionedFrameAsset({ ...approved, assetType: "REFERENCE", mimeType: "image/webp" }, scope).assetType).toBe("REFERENCE");
  });

  it("rejects cross-project assets", () => {
    expect(() => validateConditionedFrameAsset({ ...approved, creatorProjectId: 8 }, scope)).toThrow("CREATOR_CONDITION_FRAME_ASSET_SCOPE_MISMATCH");
  });

  it("rejects rejected or mutable assets", () => {
    expect(() => validateConditionedFrameAsset({ ...approved, reviewDecision: "REJECTED" }, scope)).toThrow("CREATOR_CONDITION_FRAME_ASSET_NOT_APPROVED");
    expect(() => validateConditionedFrameAsset({ ...approved, immutable: 0 }, scope)).toThrow("CREATOR_CONDITION_FRAME_ASSET_MUTABLE");
  });

  it("rejects missing and wrong-media assets", () => {
    expect(() => validateConditionedFrameAsset(undefined, scope)).toThrow("CREATOR_CONDITION_FRAME_ASSET_NOT_FOUND");
    expect(() => validateConditionedFrameAsset({ ...approved, assetType: "VIDEO", mimeType: "video/mp4" }, scope)).toThrow("CREATOR_CONDITION_FRAME_ASSET_NOT_IMAGE");
  });
});
