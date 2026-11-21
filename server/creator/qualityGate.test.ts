import { describe, expect, it } from "vitest";
import { scoreCreatorRenderQuality } from "./qualityGate";

const dimensions = {
  "VQ-CONTENT-01": 5,
  "VQ-TEMPORAL-01": 5,
  "VQ-IDENTITY-01": 5,
  "VQ-VISUAL-01": 5,
  "VQ-CAMERA-01": 5,
  "VQ-AUDIO-01": 5,
  "VQ-TEXT-01": 5,
  "VQ-DELIVERY-01": 5,
};
const target = { width: 1920, height: 1080, fps: 24, durationSeconds: 120, hasAudio: true };

describe("Creator governed quality gate", () => {
  it("allows only HUMAN evidence to reach publish-candidate quality", () => {
    expect(scoreCreatorRenderQuality({ reviewerType: "HUMAN", dimensionScores: dimensions, criticalDefects: [], actual: target, target }).decision)
      .toBe("PUBLISH_CANDIDATE");
    expect(scoreCreatorRenderQuality({ reviewerType: "ASSISTED_HUMAN", dimensionScores: dimensions, criticalDefects: [], actual: target, target }).decision)
      .toBe("PREVIEW_CANDIDATE");
  });

  it("rejects any recorded critical defect even with perfect dimension scores", () => {
    const result = scoreCreatorRenderQuality({
      reviewerType: "HUMAN",
      dimensionScores: dimensions,
      criticalDefects: ["persistent flicker"],
      actual: target,
      target,
    });
    expect(result.decision).toBe("REJECT");
    expect(result.remediationSummary.items[0]?.priority).toBe("CRITICAL");
  });

  it("returns targeted remediation rather than hiding weak dimensions behind an average", () => {
    const result = scoreCreatorRenderQuality({
      reviewerType: "HUMAN",
      dimensionScores: { ...dimensions, "VQ-TEXT-01": 2 },
      criticalDefects: [],
      actual: target,
      target,
    });
    expect(result.decision).toBe("REGENERATE");
    expect(result.remediationSummary.items.some(item => item.id === "VQ-TEXT-01")).toBe(true);
  });

  it("blocks review when final render evidence does not conform to the master target", () => {
    expect(() => scoreCreatorRenderQuality({
      reviewerType: "HUMAN",
      dimensionScores: dimensions,
      criticalDefects: [],
      actual: { ...target, width: 1280 },
      target,
    })).toThrow("CREATOR_QUALITY_OUTPUT_NONCONFORMANT:width");
  });
});
