import type { EvaluationDimensionSpec, EvaluationObservation, EvaluationScorecard } from "./types";

export function scoreEvaluation(
  specs: readonly EvaluationDimensionSpec[],
  observations: readonly EvaluationObservation[],
): EvaluationScorecard {
  const reasons: string[] = [];
  const byDimension = new Map(observations.map(observation => [observation.dimension, observation]));
  const weightTotal = specs.reduce((sum, spec) => sum + spec.weight, 0);
  if (weightTotal !== 100) reasons.push(`invalid-weight-total:${weightTotal}`);

  const perDimension = specs.map(spec => {
    const observation = byDimension.get(spec.id);
    if (!observation) {
      reasons.push(`missing-observation:${spec.id}`);
      return { dimension: spec.id, score: 0, weightedContribution: 0, pass: false };
    }

    if (!Number.isFinite(observation.score) || observation.score < 0 || observation.score > 100) {
      reasons.push(`invalid-score:${spec.id}`);
    }
    if (!observation.evidenceIds.length) reasons.push(`missing-evidence:${spec.id}`);
    for (const requiredKind of spec.evidenceRequired) {
      if (!observation.evidenceKinds.includes(requiredKind)) reasons.push(`missing-evidence-kind:${spec.id}:${requiredKind}`);
    }

    const boundedScore = Math.max(0, Math.min(100, observation.score));
    return {
      dimension: spec.id,
      score: boundedScore,
      weightedContribution: boundedScore * spec.weight / 100,
      pass: boundedScore >= spec.minimumPassScore,
    };
  });

  const score = Number(perDimension.reduce((sum, item) => sum + item.weightedContribution, 0).toFixed(2));
  const complete = reasons.length === 0;
  const pass = complete && perDimension.every(item => item.pass);
  if (complete && !pass) reasons.push("one-or-more-dimensions-below-threshold");

  return { score, pass, complete, reasons, perDimension };
}
