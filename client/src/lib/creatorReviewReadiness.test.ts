import { describe, expect, it } from "vitest";
import { creatorReviewReadiness, type CreatorReviewEvidence } from "./creatorReviewReadiness";

const dimensions = ["VQ-CONTENT-01", "VQ-TEMPORAL-01"] as const;
const scores = { "VQ-CONTENT-01": "4.5", "VQ-TEMPORAL-01": "4.0" };
const quality: CreatorReviewEvidence = { assetId: 21, reviewType: "QUALITY", decision: "PASS" };
const tamil: CreatorReviewEvidence = { assetId: 21, reviewType: "HUMAN_TAMIL", decision: "PASS" };
const visual: CreatorReviewEvidence = { assetId: 21, reviewType: "HUMAN_VISUAL", decision: "PASS" };

function gate(overrides: Partial<Parameters<typeof creatorReviewReadiness>[0]> = {}) {
  return creatorReviewReadiness({
    candidateId: 21, candidateDecision: "PENDING", watchedAssetId: 21,
    notes: "Reviewed the full candidate including Tamil dialogue and visual continuity.",
    source: "Approved storyboard revision", qualityScores: scores, dimensionIds: dimensions,
    reviews: [], ...overrides,
  });
}

describe("Creator candidate-specific human review guard", () => {
  it("requires full playback of this exact candidate before positive review", () => {
    expect(gate({ watchedAssetId: undefined }).quality).toBe(false);
    expect(gate({ watchedAssetId: 20, reviews: [quality, tamil, visual] }).finalize).toBe(false);
    expect(gate().quality).toBe(true);
  });
  it("requires new human notes, a source and explicitly entered scores", () => {
    expect(gate({ notes: "  " }).quality).toBe(false);
    expect(gate({ source: " " }).quality).toBe(false);
    expect(gate({ qualityScores: { ...scores, "VQ-TEMPORAL-01": "" } }).quality).toBe(false);
    expect(gate({ qualityScores: { ...scores, "VQ-TEMPORAL-01": "6" } }).quality).toBe(false);
    expect(gate({ qualityScores: { ...scores, "VQ-TEMPORAL-01": "NaN" } }).quality).toBe(false);
  });
  it("does not accept stale reviews belonging to a previous render", () => {
    const oldReviews = [quality, tamil, visual];
    const state = gate({ candidateId: 22, watchedAssetId: 22, reviews: oldReviews });
    expect(state.quality).toBe(true);
    expect(state.tamilPass).toBe(false);
    expect(state.finalize).toBe(false);
  });
  it("requires quality PASS before Tamil or visual PASS", () => {
    expect(gate().tamilPass).toBe(false);
    expect(gate({ reviews: [{ ...quality, decision: "REGENERATE" }] }).visualPass).toBe(false);
    expect(gate({ reviews: [quality] }).tamilPass).toBe(true);
    expect(gate({ reviews: [quality] }).visualPass).toBe(true);
  });
  it("requires all three matching PASS reviews before final promotion", () => {
    expect(gate({ reviews: [quality, tamil] }).finalize).toBe(false);
    expect(gate({ reviews: [quality, tamil, visual] }).finalize).toBe(true);
    expect(gate({ reviews: [quality, { ...tamil, decision: "REJECT" }, visual] }).finalize).toBe(false);
  });
  it("rejects duplicate decisions and rejected assets", () => {
    expect(gate({ reviews: [quality] }).quality).toBe(false);
    expect(gate({ reviews: [quality, tamil] }).tamilPass).toBe(false);
    expect(gate({ candidateDecision: "REJECTED", reviews: [quality, tamil, visual] }).finalize).toBe(false);
  });
  it("allows a documented rejection without full playback only after quality PASS", () => {
    expect(gate({ watchedAssetId: undefined, reviews: [quality] }).tamilReject).toBe(true);
    expect(gate({ watchedAssetId: undefined, reviews: [] }).visualReject).toBe(false);
  });
});
