import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const requestPath = process.argv[2];
const reviewPath = process.argv[3];
const manifestPath = process.argv[4];

if (!requestPath || !reviewPath || !manifestPath) {
  console.error('Usage: node scripts/validate-video-assembly-manifest.mjs <generation-request.json> <shot-review.json> <assembly-manifest.json>');
  process.exit(2);
}

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const request = readJson(requestPath);
const manifest = readJson(manifestPath);

const regenerationPlan = JSON.parse(execFileSync(process.execPath, [
  'scripts/plan-video-shot-regeneration.mjs',
  requestPath,
  reviewPath,
], { encoding: 'utf8' }));

if (regenerationPlan.decision === 'REJECT_FULL_VIDEO') {
  throw new Error('Assembly is forbidden when shot review requires full-video rejection.');
}
if (manifest.schemaVersion !== '1.0.0') throw new Error('assembly manifest schemaVersion must be 1.0.0');
if (manifest.requestId !== request.requestId) throw new Error('assembly manifest requestId must match generation request');
if (manifest.policy?.evidenceBased !== true) throw new Error('assembly manifest must be evidence-based');
if (manifest.policy?.preserveAcceptedShots !== true) throw new Error('assembly manifest must preserve accepted shots');
if (manifest.policy?.productionApproved !== false || manifest.policy?.paidProviderApproved !== false) {
  throw new Error('assembly manifest cannot grant production or paid-provider approval');
}
if (manifest.transitionPolicy !== 'CUT_ONLY') {
  throw new Error('transitionPolicy must be CUT_ONLY unless a separately governed transition contract is introduced');
}
if (!Array.isArray(manifest.shots) || manifest.shots.length !== request.shots.length) {
  throw new Error('assembly manifest must contain every requested shot exactly once');
}

const requestIds = request.shots.map(shot => shot.shotId);
const manifestIds = manifest.shots.map(shot => shot.shotId);
if (new Set(manifestIds).size !== manifestIds.length) throw new Error('assembly manifest contains duplicate shotId values');
if (JSON.stringify(manifestIds) !== JSON.stringify(requestIds)) throw new Error('assembly shot order must exactly match generation request order');

const regenerateSet = new Set(regenerationPlan.regenerateShotIds);
const preserveSet = new Set(regenerationPlan.preserveShotIds);
let totalDurationSeconds = 0;

for (let i = 0; i < request.shots.length; i += 1) {
  const requested = request.shots[i];
  const assembled = manifest.shots[i];
  if (!assembled.assetId || typeof assembled.assetId !== 'string') throw new Error(`${assembled.shotId}: assetId is required`);
  if (assembled.durationSeconds !== requested.durationSeconds) {
    throw new Error(`${assembled.shotId}: duration must remain ${requested.durationSeconds}s`);
  }
  totalDurationSeconds += assembled.durationSeconds;

  if (regenerateSet.has(assembled.shotId)) {
    if (assembled.sourceType !== 'REGENERATED') throw new Error(`${assembled.shotId}: failed shot must use REGENERATED sourceType`);
    if (!assembled.parentAssetId || typeof assembled.parentAssetId !== 'string') throw new Error(`${assembled.shotId}: regenerated shot must retain parentAssetId provenance`);
    if (assembled.qualityReviewRequired !== true) throw new Error(`${assembled.shotId}: regenerated shot requires fresh quality review`);
    if (assembled.immutable !== false) throw new Error(`${assembled.shotId}: regenerated replacement must not claim immutable original status`);
  } else if (preserveSet.has(assembled.shotId)) {
    if (assembled.sourceType !== 'ORIGINAL_ACCEPTED') throw new Error(`${assembled.shotId}: accepted shot must remain ORIGINAL_ACCEPTED`);
    if (assembled.parentAssetId !== null) throw new Error(`${assembled.shotId}: preserved original must not have parentAssetId`);
    if (assembled.qualityReviewRequired !== false) throw new Error(`${assembled.shotId}: preserved accepted shot must not be forced through regeneration review`);
    if (assembled.immutable !== true) throw new Error(`${assembled.shotId}: preserved accepted shot must be immutable`);
  } else {
    throw new Error(`${assembled.shotId}: shot is absent from regeneration decision`);
  }
}

if (totalDurationSeconds !== request.target.durationSeconds) {
  throw new Error(`assembled duration ${totalDurationSeconds}s must equal requested target ${request.target.durationSeconds}s`);
}

console.log(JSON.stringify({
  schemaVersion: '1.0.0',
  requestId: request.requestId,
  decision: 'ASSEMBLY_MANIFEST_VALID',
  preservedShotIds: regenerationPlan.preserveShotIds,
  regeneratedShotIds: regenerationPlan.regenerateShotIds,
  totalDurationSeconds,
  transitionPolicy: manifest.transitionPolicy,
  productionApproved: false,
  paidProviderApproved: false,
}, null, 2));
