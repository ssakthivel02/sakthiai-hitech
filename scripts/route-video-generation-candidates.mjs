import fs from 'node:fs';

const evidencePath = 'research/generative-media/video-provider-evidence.json';
const requestPath = process.argv[2];

if (!requestPath) {
  console.error('Usage: node scripts/route-video-generation-candidates.mjs <video-generation-request.json>');
  process.exit(2);
}

function readJson(file) {
  if (!fs.existsSync(file)) throw new Error(`Missing file: ${file}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function resolutionHeight(label) {
  const match = /^(\d+)p$/i.exec(label ?? '');
  if (match) return Number(match[1]);
  if (String(label).toLowerCase() === '4k') return 2160;
  return null;
}

const evidence = readJson(evidencePath);
const request = readJson(requestPath);

if (evidence.policy?.providerNeutral !== true || evidence.policy?.researchOnly !== true) {
  throw new Error('Video provider evidence must remain provider-neutral and research-only.');
}
if (evidence.policy?.productionApproved !== false || evidence.policy?.paidProviderApproved !== false) {
  throw new Error('Routing evidence cannot grant production or paid-provider approval.');
}
if (evidence.policy?.noProviderRankingWithoutSakthiAIBenchmark !== true) {
  throw new Error('Provider ranking must remain blocked without SakthiAI benchmark evidence.');
}
if (request.qualityPolicy?.productionApproved !== false || request.qualityPolicy?.paidProviderApproved !== false) {
  throw new Error('Generation request cannot self-approve production or paid-provider use.');
}

const requiredReferenceCount = request.continuity?.identityLockRequired === true
  ? (request.continuity.referenceAssetIds?.length ?? 0)
  : 0;
const maxShotDuration = Math.max(...(request.shots ?? []).map(shot => Number(shot.durationSeconds ?? 0)));
const requiresAudio = request.audioPolicy?.audioRequired === true;
const targetHeight = Number(request.target?.height ?? 0);
const targetAspectRatio = request.target?.aspectRatio;

const evaluated = [];
for (const provider of evidence.providers ?? []) {
  const reasons = [];
  const facts = provider.verifiedFacts ?? {};

  if (provider.integrationState !== 'CANDIDATE_RESEARCH_ONLY') {
    reasons.push(`integration state is ${provider.integrationState}`);
  }

  const aspectRatios = facts.documentedAspectRatios;
  if (!Array.isArray(aspectRatios) || !aspectRatios.includes(targetAspectRatio)) {
    reasons.push(`target aspect ratio ${targetAspectRatio} is not verified in current evidence`);
  }

  const durationCandidates = [];
  if (Array.isArray(facts.documentedClipDurationSeconds)) durationCandidates.push(...facts.documentedClipDurationSeconds.map(Number));
  if (Array.isArray(facts.documentedDurationRangeSeconds) && facts.documentedDurationRangeSeconds.length === 2) {
    durationCandidates.push(Number(facts.documentedDurationRangeSeconds[1]));
  }
  if (Array.isArray(facts.documentedDurationsSeconds)) durationCandidates.push(...facts.documentedDurationsSeconds.map(Number));
  const verifiedMaxDuration = durationCandidates.filter(Number.isFinite).length
    ? Math.max(...durationCandidates.filter(Number.isFinite))
    : null;
  if (verifiedMaxDuration === null || maxShotDuration > verifiedMaxDuration) {
    reasons.push(`maximum shot duration ${maxShotDuration}s exceeds or lacks verified provider duration support`);
  }

  let verifiedMaxHeight = null;
  if (Array.isArray(facts.documentedResolutions)) {
    const heights = facts.documentedResolutions.map(resolutionHeight).filter(Number.isFinite);
    if (heights.length) verifiedMaxHeight = Math.max(...heights);
  }
  if (typeof facts.documentedOutputResolution === 'string') {
    const height = resolutionHeight(facts.documentedOutputResolution);
    if (Number.isFinite(height)) verifiedMaxHeight = Math.max(verifiedMaxHeight ?? 0, height);
  }
  if (targetHeight > 0 && (verifiedMaxHeight === null || verifiedMaxHeight < targetHeight)) {
    reasons.push(`target height ${targetHeight}px exceeds or lacks verified provider output resolution support`);
  }

  if (requiresAudio && facts.nativeAudio !== true && facts.syncedAudio !== true) {
    reasons.push('required generated audio is not verified in current provider evidence');
  }

  if (requiredReferenceCount > 0) {
    const maxReferences = Number(facts.referenceImagesMaximum ?? 0);
    if (!(maxReferences >= requiredReferenceCount)) {
      reasons.push(`${requiredReferenceCount} identity/reference asset(s) required but current evidence does not verify sufficient reference conditioning`);
    }
  }

  evaluated.push({
    providerId: provider.providerId,
    provider: provider.provider,
    product: provider.product,
    integrationState: provider.integrationState,
    eligible: reasons.length === 0,
    reasons,
    routingSignals: reasons.length === 0 ? provider.sakthiaiRoutingSignals : [],
  });
}

const eligibleCandidates = evaluated.filter(item => item.eligible).map(item => ({
  providerId: item.providerId,
  provider: item.provider,
  product: item.product,
  routingSignals: item.routingSignals,
}));

const result = {
  schemaVersion: '1.0.0',
  requestId: request.requestId,
  evidenceLastVerifiedDate: evidence.lastVerifiedDate,
  policy: {
    researchOnly: true,
    ranked: false,
    paidProviderApproved: false,
    productionApproved: false,
    selectionRule: 'Eligibility is evidence-based only. No provider quality ranking is permitted until SakthiAI benchmark evidence exists.',
  },
  requirements: {
    targetAspectRatio,
    targetHeight,
    maxShotDurationSeconds: maxShotDuration,
    audioRequired: requiresAudio,
    identityReferenceCount: requiredReferenceCount,
  },
  eligibleCandidates,
  evaluated,
};

console.log(JSON.stringify(result, null, 2));
