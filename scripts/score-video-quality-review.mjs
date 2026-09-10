import fs from 'node:fs';
import crypto from 'node:crypto';

const specPath = 'research/evaluation/video-quality-spec.json';
const remediationPath = 'research/evaluation/video-quality-remediation-map.json';
const reviewPath = process.argv[2];

if (!reviewPath) {
  console.error('Usage: node scripts/score-video-quality-review.mjs <review.json>');
  process.exit(2);
}

function readJson(file) {
  if (!fs.existsSync(file)) throw new Error(`Missing file: ${file}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function gitBlobSha(file) {
  const body = fs.readFileSync(file);
  const header = Buffer.from(`blob ${body.length}\0`);
  return crypto.createHash('sha1').update(Buffer.concat([header, body])).digest('hex');
}

const spec = readJson(specPath);
const remediation = readJson(remediationPath);
const review = readJson(reviewPath);

if (review.specId !== spec.stableId) throw new Error(`Review specId must be ${spec.stableId}`);
if (remediation.specId !== spec.stableId) throw new Error(`Remediation map specId must be ${spec.stableId}`);
if (remediation.providerNeutral !== true || remediation.runtimeApproved !== false) throw new Error('Video remediation map must remain provider-neutral and runtimeApproved=false');

const requestRef = review.generationRequest;
if (!requestRef || typeof requestRef !== 'object') throw new Error('generationRequest traceability evidence is required');
if (typeof requestRef.path !== 'string' || !requestRef.path.startsWith('research/generative-media/') || !requestRef.path.endsWith('.json')) {
  throw new Error('generationRequest.path must point to a governed research/generative-media JSON request');
}
if (!fs.existsSync(requestRef.path)) throw new Error(`Linked generation request not found: ${requestRef.path}`);
if (!/^[0-9a-f]{40}$/.test(requestRef.gitBlobSha ?? '')) throw new Error('generationRequest.gitBlobSha must be a 40-character lowercase Git blob SHA');
const linkedRequestSha = gitBlobSha(requestRef.path);
if (linkedRequestSha !== requestRef.gitBlobSha) {
  throw new Error(`Linked generation request content drift detected: expected ${requestRef.gitBlobSha}, got ${linkedRequestSha}`);
}
const linkedRequest = readJson(requestRef.path);
if (linkedRequest.requestId !== requestRef.requestId) throw new Error('generationRequest.requestId does not match linked request content');
if (linkedRequest.qualityPolicy?.postGenerationSpecId !== spec.stableId) throw new Error('Linked generation request does not target the active SakthiAI video quality specification');
if (linkedRequest.qualityPolicy?.productionApproved !== false || linkedRequest.qualityPolicy?.paidProviderApproved !== false) {
  throw new Error('Linked generation request cannot self-approve production or paid-provider use');
}

if (!review.sourcePromptOrStoryboard || typeof review.sourcePromptOrStoryboard !== 'string') throw new Error('sourcePromptOrStoryboard is required');
if (!review.reviewer || !['HUMAN', 'ASSISTED_HUMAN'].includes(review.reviewer.type)) throw new Error('reviewer.type must be HUMAN or ASSISTED_HUMAN');
if (!review.reviewer.reviewTimestamp) throw new Error('reviewer.reviewTimestamp is required');
if (!review.output || !(review.output.durationSeconds > 0) || !(review.output.width > 0) || !(review.output.height > 0)) throw new Error('Valid output durationSeconds/width/height are required');
if (!(review.output.fps > 0)) throw new Error('Valid output fps is required');

const target = linkedRequest.target;
if (!target || !(target.width > 0) || !(target.height > 0) || !(target.fps > 0) || !(target.durationSeconds > 0)) {
  throw new Error('Linked generation request must define positive target width/height/fps/durationSeconds');
}

const durationToleranceSeconds = 0.1;
const fpsTolerance = 0.01;
const outputConformanceChecks = {
  width: review.output.width === target.width,
  height: review.output.height === target.height,
  fps: Math.abs(review.output.fps - target.fps) <= fpsTolerance,
  duration: Math.abs(review.output.durationSeconds - target.durationSeconds) <= durationToleranceSeconds,
  audio: linkedRequest.audioPolicy?.audioRequired !== true || review.output.hasAudio === true,
};
const failedOutputConformance = Object.entries(outputConformanceChecks)
  .filter(([, passed]) => !passed)
  .map(([name]) => name);
if (failedOutputConformance.length > 0) {
  throw new Error(`Output does not conform to linked generation request: ${failedOutputConformance.join(', ')}`);
}

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

const remediationItems = [];
for (const item of perDimension) {
  if (item.score < 4) {
    const guidance = remediation.remediationByDimension?.[item.id];
    if (!guidance) throw new Error(`Missing remediation guidance for ${item.id}`);
    remediationItems.push({
      id: item.id,
      score: item.score,
      priority: guidance.priority,
      problem: guidance.problem,
      actions: guidance.actions,
    });
  }
}

if (criticalDefects.length > 0) {
  remediationItems.unshift({
    id: 'CRITICAL-DEFECT',
    score: null,
    priority: 'CRITICAL',
    problem: `${criticalDefects.length} critical defect(s) recorded`,
    actions: [remediation.decisionGuidance?.REJECT ?? 'Reject and regenerate the affected output.'],
  });
}

remediationItems.sort((a, b) => {
  const rank = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
  return (rank[a.priority] ?? 9) - (rank[b.priority] ?? 9);
});

const result = {
  specId: spec.stableId,
  generationRequest: {
    requestId: requestRef.requestId,
    path: requestRef.path,
    gitBlobSha: linkedRequestSha,
    traceabilityVerified: true,
  },
  outputConformance: {
    verified: true,
    target: {
      width: target.width,
      height: target.height,
      fps: target.fps,
      durationSeconds: target.durationSeconds,
      audioRequired: linkedRequest.audioPolicy?.audioRequired === true,
    },
    actual: {
      width: review.output.width,
      height: review.output.height,
      fps: review.output.fps,
      durationSeconds: review.output.durationSeconds,
      hasAudio: review.output.hasAudio === true,
    },
    durationToleranceSeconds,
    fpsTolerance,
  },
  weightedScore,
  criticalDefectCount: criticalDefects.length,
  decision: computedDecision,
  perDimension,
  publishHumanReviewSatisfied: review.reviewer.type === 'HUMAN',
  remediationSummary: {
    items: remediationItems,
    decisionGuidance: remediation.decisionGuidance?.[computedDecision] ?? null,
  },
};

console.log(JSON.stringify(result, null, 2));
