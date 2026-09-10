import fs from 'node:fs';
import crypto from 'node:crypto';

const specPath = 'research/evaluation/video-release-readiness-spec.json';
const manifestPath = process.argv[2];

if (!manifestPath) {
  console.error('Usage: node scripts/validate-video-release-readiness.mjs <readiness.json>');
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
const manifest = readJson(manifestPath);

if (manifest.specId !== spec.stableId) throw new Error(`specId must be ${spec.stableId}`);
if (spec.runtimeApproved !== false || spec.productionApproved !== false) {
  throw new Error('Release readiness specification must remain non-runtime and non-production-approved');
}
if (spec.policy?.ownerPublishApprovalMustRemainSeparate !== true) {
  throw new Error('Release readiness specification must preserve separate owner publication approval');
}

const qualityRef = manifest.qualityReview;
if (!qualityRef || typeof qualityRef !== 'object') throw new Error('qualityReview evidence is required');
if (typeof qualityRef.path !== 'string' || !qualityRef.path.startsWith('research/evaluation/fixtures/') || !qualityRef.path.endsWith('.json')) {
  throw new Error('qualityReview.path must point to a governed evaluation JSON review');
}
if (!/^[0-9a-f]{40}$/.test(qualityRef.gitBlobSha ?? '')) throw new Error('qualityReview.gitBlobSha must be a 40-character lowercase Git blob SHA');
if (!fs.existsSync(qualityRef.path)) throw new Error(`Linked quality review not found: ${qualityRef.path}`);
const qualitySha = gitBlobSha(qualityRef.path);
if (qualitySha !== qualityRef.gitBlobSha) {
  throw new Error(`Linked quality review content drift detected: expected ${qualityRef.gitBlobSha}, got ${qualitySha}`);
}

const qualityReview = readJson(qualityRef.path);
if (qualityReview.specId !== 'SAI-VIDEO-QUALITY') throw new Error('Linked quality review must use SAI-VIDEO-QUALITY');
if (qualityReview.decision !== 'PUBLISH_CANDIDATE') throw new Error('Only a PUBLISH_CANDIDATE quality review can reach release readiness');
if (qualityReview.reviewer?.type !== 'HUMAN') throw new Error('Release readiness requires a HUMAN quality review');
if ((qualityReview.criticalDefects ?? []).filter(Boolean).length !== 0) throw new Error('Release readiness requires zero critical defects');

const generationRef = qualityReview.generationRequest;
if (!generationRef || typeof generationRef !== 'object') throw new Error('Linked quality review must preserve generation request traceability');
if (!fs.existsSync(generationRef.path)) throw new Error(`Linked generation request not found: ${generationRef.path}`);
if (!/^[0-9a-f]{40}$/.test(generationRef.gitBlobSha ?? '')) throw new Error('Generation request Git blob SHA is invalid');
const generationSha = gitBlobSha(generationRef.path);
if (generationSha !== generationRef.gitBlobSha) throw new Error('Generation request content drift detected');
const generationRequest = readJson(generationRef.path);
if (generationRequest.requestId !== generationRef.requestId) throw new Error('Generation request ID mismatch');
if (generationRequest.qualityPolicy?.productionApproved !== false) throw new Error('Generation request must not self-approve production');
if (generationRequest.qualityPolicy?.paidProviderApproved !== false) throw new Error('Generation request must not self-approve paid-provider use');

const rights = manifest.rightsReview;
if (!rights || typeof rights !== 'object') throw new Error('rightsReview is required');
for (const field of ['sourceAssetsRightsCleared', 'musicRightsCleared', 'voiceRightsCleared', 'identityConsentSatisfied']) {
  if (rights[field] !== true) throw new Error(`${field} must be explicitly true before owner-approval readiness`);
}
if (manifest.platformPolicyReviewed !== true) throw new Error('platformPolicyReviewed must be explicitly true');

const language = manifest.languageReview;
if (!language || typeof language !== 'object') throw new Error('languageReview is required');
if (typeof language.tamilContentPresent !== 'boolean') throw new Error('languageReview.tamilContentPresent must be boolean');
if (typeof language.tamilHumanReviewSatisfied !== 'boolean') throw new Error('languageReview.tamilHumanReviewSatisfied must be boolean');
if (language.tamilContentPresent && language.tamilHumanReviewSatisfied !== true) {
  throw new Error('Tamil content requires explicit Tamil human review before owner-approval readiness');
}
if (language.tamilContentPresent && qualityReview.reviewer?.tamilQualityHumanReviewed !== true) {
  throw new Error('Tamil content requires the linked quality review to record tamilQualityHumanReviewed=true');
}

if (manifest.ownerPublishApproved !== false) throw new Error('Readiness gate must not record ownerPublishApproved=true');
if (manifest.productionApproved !== false) throw new Error('Readiness gate must not record productionApproved=true');
if (manifest.paidProviderApproved !== false) throw new Error('Readiness gate must not record paidProviderApproved=true');
if (manifest.decision !== spec.readinessDecision) throw new Error(`decision must be ${spec.readinessDecision}`);

console.log(JSON.stringify({
  specId: spec.stableId,
  qualityReview: {
    path: qualityRef.path,
    gitBlobSha: qualitySha,
    decision: qualityReview.decision,
    humanReviewed: true
  },
  generationRequest: {
    requestId: generationRequest.requestId,
    gitBlobSha: generationSha,
    traceabilityVerified: true
  },
  rightsAndConsentReady: true,
  platformPolicyReviewed: true,
  tamilReviewRequired: language.tamilContentPresent,
  tamilReviewSatisfied: language.tamilContentPresent ? true : null,
  ownerPublishApproved: false,
  productionApproved: false,
  paidProviderApproved: false,
  decision: spec.readinessDecision
}, null, 2));
