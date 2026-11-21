import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const CREATOR_VIDEO_QUALITY_SPEC_ID = "SAI-VIDEO-QUALITY";

export type CreatorQualityDecision =
  | "REJECT"
  | "REGENERATE"
  | "PREVIEW_CANDIDATE"
  | "PUBLISH_CANDIDATE";

export type CreatorQualityReviewerType = "HUMAN" | "ASSISTED_HUMAN";

export type CreatorOutputEvidence = {
  width: number;
  height: number;
  fps: number;
  durationSeconds: number;
  hasAudio: boolean;
};

type Dimension = { id: string; weight: number };
type QualitySpec = {
  stableId: string;
  sakthiaiAcceptanceDimensions: Dimension[];
  acceptanceGates: {
    previewCandidate: { minimumWeightedScore: number; minimumPerDimensionScore: number };
    publishCandidate: {
      minimumWeightedScore: number;
      minimumPerDimensionScore: number;
      requiredDimensionsAtLeast4: string[];
    };
  };
};
type RemediationMap = {
  specId: string;
  providerNeutral: boolean;
  remediationByDimension: Record<string, { priority: string; problem: string; actions: string[] }>;
  decisionGuidance: Record<string, string>;
};

function readGovernedJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(resolve(process.cwd(), relativePath), "utf8")) as T;
}

export function loadCreatorQualityPolicy() {
  const spec = readGovernedJson<QualitySpec>("research/evaluation/video-quality-spec.json");
  const remediation = readGovernedJson<RemediationMap>("research/evaluation/video-quality-remediation-map.json");
  if (spec.stableId !== CREATOR_VIDEO_QUALITY_SPEC_ID || remediation.specId !== spec.stableId) {
    throw new Error("CREATOR_QUALITY_POLICY_ID_MISMATCH");
  }
  if (remediation.providerNeutral !== true) throw new Error("CREATOR_QUALITY_REMEDIATION_NOT_PROVIDER_NEUTRAL");
  if (!spec.sakthiaiAcceptanceDimensions.length) throw new Error("CREATOR_QUALITY_POLICY_EMPTY");
  return { spec, remediation };
}

export function scoreCreatorRenderQuality(input: {
  reviewerType: CreatorQualityReviewerType;
  dimensionScores: Record<string, number>;
  criticalDefects: string[];
  actual: CreatorOutputEvidence;
  target: CreatorOutputEvidence;
}) {
  const { spec, remediation } = loadCreatorQualityPolicy();
  const durationToleranceSeconds = 0.1;
  const fpsTolerance = 0.01;
  const conformance = {
    width: input.actual.width === input.target.width,
    height: input.actual.height === input.target.height,
    fps: Math.abs(input.actual.fps - input.target.fps) <= fpsTolerance,
    duration: Math.abs(input.actual.durationSeconds - input.target.durationSeconds) <= durationToleranceSeconds,
    audio: input.target.hasAudio !== true || input.actual.hasAudio === true,
  };
  const failedConformance = Object.entries(conformance).filter(([, passed]) => !passed).map(([name]) => name);
  if (failedConformance.length) {
    throw new Error(`CREATOR_QUALITY_OUTPUT_NONCONFORMANT:${failedConformance.join(",")}`);
  }

  let weightedScore = 0;
  const perDimension = spec.sakthiaiAcceptanceDimensions.map(dimension => {
    const score = input.dimensionScores[dimension.id];
    if (typeof score !== "number" || score < 0 || score > 5) {
      throw new Error(`CREATOR_QUALITY_SCORE_INVALID:${dimension.id}`);
    }
    const contribution = (score / 5) * dimension.weight;
    weightedScore += contribution;
    return { id: dimension.id, score, weight: dimension.weight, contribution: Number(contribution.toFixed(2)) };
  });
  weightedScore = Number(weightedScore.toFixed(2));

  const criticalDefects = input.criticalDefects.map(item => item.trim()).filter(Boolean);
  const preview = spec.acceptanceGates.previewCandidate;
  const publish = spec.acceptanceGates.publishCandidate;
  const allAtLeast = (minimum: number) => perDimension.every(item => item.score >= minimum);
  const requiredPublishDimensionsPass = publish.requiredDimensionsAtLeast4.every(id => {
    const item = perDimension.find(entry => entry.id === id);
    return Boolean(item && item.score >= 4);
  });

  let decision: CreatorQualityDecision = "REGENERATE";
  if (criticalDefects.length) {
    decision = "REJECT";
  } else if (
    weightedScore >= publish.minimumWeightedScore &&
    allAtLeast(publish.minimumPerDimensionScore) &&
    requiredPublishDimensionsPass &&
    input.reviewerType === "HUMAN"
  ) {
    decision = "PUBLISH_CANDIDATE";
  } else if (weightedScore >= preview.minimumWeightedScore && allAtLeast(preview.minimumPerDimensionScore)) {
    decision = "PREVIEW_CANDIDATE";
  }

  const remediationItems = perDimension
    .filter(item => item.score < 4)
    .map(item => {
      const guidance = remediation.remediationByDimension[item.id];
      if (!guidance) throw new Error(`CREATOR_QUALITY_REMEDIATION_MISSING:${item.id}`);
      return { id: item.id, score: item.score, ...guidance };
    });
  if (criticalDefects.length) {
    remediationItems.unshift({
      id: "CRITICAL-DEFECT",
      score: 0,
      priority: "CRITICAL",
      problem: `${criticalDefects.length} critical defect(s) recorded`,
      actions: [remediation.decisionGuidance.REJECT ?? "Reject the affected output."],
    });
  }
  const rank: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
  remediationItems.sort((a, b) => (rank[a.priority] ?? 9) - (rank[b.priority] ?? 9));

  return {
    specId: spec.stableId,
    weightedScore,
    decision,
    criticalDefects,
    perDimension,
    outputConformance: {
      verified: true,
      checks: conformance,
      target: input.target,
      actual: input.actual,
      durationToleranceSeconds,
      fpsTolerance,
    },
    publishHumanReviewSatisfied: input.reviewerType === "HUMAN",
    remediationSummary: {
      items: remediationItems,
      decisionGuidance: remediation.decisionGuidance[decision] ?? null,
    },
  };
}
