import fs from 'node:fs';

const requestPath = process.argv[2];
const reviewPath = process.argv[3];

if (!requestPath || !reviewPath) {
  console.error('Usage: node scripts/plan-video-shot-regeneration.mjs <generation-request.json> <shot-review.json>');
  process.exit(2);
}

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const request = readJson(requestPath);
const review = readJson(reviewPath);

if (request.requestId !== review.requestId) throw new Error('Shot review requestId must match generation request.');
if (request.qualityPolicy?.regenerateFailedShotsOnly !== true) throw new Error('Generation request must explicitly require failed-shot-only regeneration.');
if (request.qualityPolicy?.productionApproved !== false || request.qualityPolicy?.paidProviderApproved !== false) {
  throw new Error('Generation request cannot self-approve production or paid-provider use.');
}
if (!Array.isArray(request.shots) || request.shots.length === 0) throw new Error('Generation request must contain shots.');
if (!Array.isArray(review.shots) || review.shots.length !== request.shots.length) throw new Error('Shot review must cover every requested shot exactly once.');
if (!Array.isArray(review.globalCriticalDefects)) throw new Error('globalCriticalDefects must be an array.');

const requestIds = request.shots.map(shot => shot.shotId);
const reviewIds = review.shots.map(shot => shot.shotId);
if (new Set(reviewIds).size !== reviewIds.length) throw new Error('Shot review contains duplicate shotId values.');
for (const id of requestIds) if (!reviewIds.includes(id)) throw new Error(`Shot review missing ${id}.`);
for (const id of reviewIds) if (!requestIds.includes(id)) throw new Error(`Shot review contains unknown shot ${id}.`);

const threshold = 4;
const dimensions = ['temporal', 'identity', 'visual', 'camera'];
const shotResults = request.shots.map(requestShot => {
  const reviewShot = review.shots.find(item => item.shotId === requestShot.shotId);
  if (!reviewShot?.scores) throw new Error(`${requestShot.shotId} missing scores.`);
  const failedDimensions = [];
  for (const dimension of dimensions) {
    const score = reviewShot.scores[dimension];
    if (typeof score !== 'number' || score < 0 || score > 5) throw new Error(`${requestShot.shotId}.${dimension} must be 0..5.`);
    if (score < threshold) failedDimensions.push({ dimension, score });
  }
  const criticalDefects = Array.isArray(reviewShot.criticalDefects) ? reviewShot.criticalDefects.filter(Boolean) : [];
  const regenerate = failedDimensions.length > 0 || criticalDefects.length > 0;
  return {
    shotId: requestShot.shotId,
    regenerate,
    failedDimensions,
    criticalDefects,
    preserve: !regenerate,
  };
});

const fullVideoReject = review.globalCriticalDefects.length > 0;
const regenerateShotIds = fullVideoReject ? requestIds : shotResults.filter(item => item.regenerate).map(item => item.shotId);
const preserveShotIds = fullVideoReject ? [] : shotResults.filter(item => item.preserve).map(item => item.shotId);

const result = {
  schemaVersion: '1.0.0',
  requestId: request.requestId,
  policy: {
    evidenceBased: true,
    selectiveRegeneration: !fullVideoReject,
    productionApproved: false,
    paidProviderApproved: false,
    minimumPerShotDimensionScore: threshold,
  },
  decision: fullVideoReject ? 'REJECT_FULL_VIDEO' : regenerateShotIds.length ? 'REGENERATE_FAILED_SHOTS' : 'PRESERVE_ALL_SHOTS',
  globalCriticalDefects: review.globalCriticalDefects,
  regenerateShotIds,
  preserveShotIds,
  shotResults,
};

console.log(JSON.stringify(result, null, 2));
