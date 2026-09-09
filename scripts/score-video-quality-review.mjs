import fs from 'node:fs';

const specPath = 'research/evaluation/video-quality-spec.json';
const reviewPath = process.argv[2];

if (!reviewPath) {
  console.error('Usage: node scripts/score-video-quality-review.mjs <review.json>');
  process.exit(2);
}

function readJson(file) {
  if (!fs.existsSync(file)) throw new Error(`Missing file: ${file}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const spec = readJson(specPath);
const review = readJson(reviewPath);

if (review.specId !== spec.stableId) throw new Error(`Review specId must be ${spec.stableId}`);
if (!review.sourcePromptOrStoryboard || typeof review.sourcePromptOrStoryboard !== 'string') throw new Error('sourcePromptOrStoryboard is required');
if (!review.reviewer || !['HUMAN', 'ASSISTED_HUMAN'].includes(review.reviewer.type)) throw new Error('reviewer.type must be HUMAN or ASSISTED_HUMAN');
if (!review.reviewer.reviewTimestamp) throw new Error('reviewer.reviewTimestamp is required');
if (!review.output || !(review.output.durationSeconds > 0) || !(review.output.width > 0) || !(review.output.height > 0)) throw new Error('Valid output durationSeconds/width/height are required');

const dimensions = spec.sakthiaiAcceptanceDimensions ?? [];
if (dimensions.length === 0) throw new Error('Video quality specification has no dimensions');

let weightedScore = 0;
const perDimension = [];
for (const dimension of dimensions) {
  const score = review.dimensionScores?.[dimension.id];
  if (typeof score !== 'number' || score < 0 || score > 5) throw new Error(`${dimension.id} score must be between 0 and 5`);
  const contribution = (score / 5) * dimension.weight;
  weightedScore += contribution;
  perDimension.push({ id: dimension.id, score, weight: dimension.weight, contribution: Number(contribution.toFixed(2)) });
}
weightedScore = Number(weightedScore.toFixed(2));

const criticalDefects = Array.isArray(review.criticalDefects) ? review.criticalDefects.filter(Boolean) : [];
const preview = spec.acceptanceGates?.previewCandidate;
const publish = spec.acceptanceGates?.publishCandidate;

const allAtLeast = minimum => perDimension.every(item => item.score >= minimum);
const requiredPublishDimensionsPass = (publish?.requiredDimensionsAtLeast4 ?? []).every(id => {
  const item = perDimension.find(entry => entry.id === id);
  return item && item.score >= 4;
});

let computedDecision = 'REGENERATE';
if (criticalDefects.length > 0) {
  computedDecision = 'REJECT';
} else if (
  weightedScore >= publish.minimumWeightedScore &&
  allAtLeast(publish.minimumPerDimensionScore) &&
  requiredPublishDimensionsPass &&
  review.reviewer.type === 'HUMAN'
) {
  computedDecision = 'PUBLISH_CANDIDATE';
} else if (
  weightedScore >= preview.minimumWeightedScore &&
  allAtLeast(preview.minimumPerDimensionScore)
) {
  computedDecision = 'PREVIEW_CANDIDATE';
}

if (review.decision !== computedDecision) {
  throw new Error(`Recorded decision ${review.decision} does not match computed decision ${computedDecision}`);
}

const result = {
  specId: spec.stableId,
  weightedScore,
  criticalDefectCount: criticalDefects.length,
  decision: computedDecision,
  perDimension,
  publishHumanReviewSatisfied: review.reviewer.type === 'HUMAN',
};

console.log(JSON.stringify(result, null, 2));
