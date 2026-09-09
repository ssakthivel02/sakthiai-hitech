import fs from 'node:fs';

const requestPath = process.argv[2];
if (!requestPath) {
  console.error('Usage: node scripts/validate-video-generation-request.mjs <request.json>');
  process.exit(2);
}

function fail(message) {
  throw new Error(message);
}

function readJson(file) {
  if (!fs.existsSync(file)) fail(`Missing file: ${file}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const request = readJson(requestPath);

if (request.schemaVersion !== '1.0.0') fail('schemaVersion must be 1.0.0');
if (!/^VGEN-[A-Z0-9-]+$/.test(request.requestId ?? '')) fail('requestId must match VGEN-*');

const allowedCapabilities = new Set([
  'GM-T2V', 'GM-I2V', 'GM-V2V', 'GM-EXTEND', 'GM-REFCOND',
  'GM-CONSISTENCY', 'GM-CAMERA', 'GM-MULTISHOT', 'GM-EDIT-VIDEO',
]);
if (!allowedCapabilities.has(request.capabilityId)) fail('Unsupported video capabilityId');

const target = request.target ?? {};
if (!(target.width >= 720) || !(target.height >= 720)) fail('Target dimensions must each be at least 720 pixels');
if (!(target.fps >= 23.976 && target.fps <= 60)) fail('Target fps must be between 23.976 and 60');
if (!(target.durationSeconds > 0 && target.durationSeconds <= 600)) fail('Target durationSeconds must be >0 and <=600');
if (!['16:9', '9:16', '1:1', '4:5', '21:9'].includes(target.aspectRatio)) fail('Unsupported aspectRatio');

const continuity = request.continuity ?? {};
if (!Array.isArray(continuity.referenceAssetIds)) fail('continuity.referenceAssetIds must be an array');
if (continuity.identityLockRequired === true && continuity.referenceAssetIds.length === 0) {
  fail('Identity lock requires at least one reference asset');
}

const textPolicy = request.textPolicy ?? {};
if (textPolicy.criticalOnScreenTextAllowedInGeneration !== false) {
  fail('Critical on-screen text must not be delegated to generative video rendering');
}
if (!['POST_PROCESS', 'CAPTION_LAYER', 'NONE_REQUIRED'].includes(textPolicy.criticalTextHandling)) {
  fail('Invalid criticalTextHandling');
}

const audioPolicy = request.audioPolicy ?? {};
if (audioPolicy.tamilHumanReviewRequiredWhenApplicable !== true) {
  fail('Tamil quality must preserve human review when applicable');
}
if (audioPolicy.lipSyncRequired === true && audioPolicy.audioRequired !== true) {
  fail('lipSyncRequired=true requires audioRequired=true');
}

const shots = request.shots;
if (!Array.isArray(shots) || shots.length === 0 || shots.length > 120) fail('shots must contain 1-120 entries');
const shotIds = new Set();
let plannedDuration = 0;
for (const shot of shots) {
  if (!/^SHOT-[0-9]{3}$/.test(shot.shotId ?? '')) fail(`Invalid shotId: ${shot.shotId}`);
  if (shotIds.has(shot.shotId)) fail(`Duplicate shotId: ${shot.shotId}`);
  shotIds.add(shot.shotId);
  if (!(shot.durationSeconds >= 1 && shot.durationSeconds <= 12)) fail(`${shot.shotId} duration must be 1-12 seconds`);
  plannedDuration += shot.durationSeconds;
  for (const field of ['subject', 'action', 'environment']) {
    if (typeof shot[field] !== 'string' || shot[field].trim().length < 3) fail(`${shot.shotId} missing ${field}`);
  }
  if (!shot.camera || !['ECU','CU','MCU','MS','MLS','WS','EWS'].includes(shot.camera.shotSize)) fail(`${shot.shotId} invalid camera shotSize`);
  if (!['LOCKED','PAN','TILT','DOLLY_IN','DOLLY_OUT','TRACK','ORBIT','CRANE','HANDHELD_CONTROLLED'].includes(shot.camera.movement)) fail(`${shot.shotId} invalid camera movement`);
  if (!Number.isInteger(shot.activeMotionCount) || shot.activeMotionCount < 0 || shot.activeMotionCount > 2) {
    fail(`${shot.shotId} activeMotionCount must be 0-2 to control motion complexity`);
  }
  if (!Array.isArray(shot.negativeConstraints) || shot.negativeConstraints.length < 2) {
    fail(`${shot.shotId} requires at least two negative constraints`);
  }
}

const durationDelta = Math.abs(plannedDuration - target.durationSeconds);
if (durationDelta > Math.max(1, target.durationSeconds * 0.05)) {
  fail(`Shot plan duration ${plannedDuration}s does not match target ${target.durationSeconds}s within tolerance`);
}

const qualityPolicy = request.qualityPolicy ?? {};
if (qualityPolicy.regenerateFailedShotsOnly !== true) fail('regenerateFailedShotsOnly must remain true');
if (!Number.isInteger(qualityPolicy.maximumWholeVideoRetriesBeforeDiagnosis) || qualityPolicy.maximumWholeVideoRetriesBeforeDiagnosis < 0 || qualityPolicy.maximumWholeVideoRetriesBeforeDiagnosis > 1) {
  fail('maximumWholeVideoRetriesBeforeDiagnosis must be 0 or 1');
}
if (qualityPolicy.postGenerationSpecId !== 'SAI-VIDEO-QUALITY') fail('postGenerationSpecId must be SAI-VIDEO-QUALITY');
if (qualityPolicy.productionApproved !== false) fail('Pre-generation request cannot self-approve production');
if (qualityPolicy.paidProviderApproved !== false) fail('Pre-generation request cannot approve paid providers');

const serialized = JSON.stringify(request);
const forbiddenSecretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /github_pat_[A-Za-z0-9_]+/,
  /ghp_[A-Za-z0-9]+/,
  /sk-[A-Za-z0-9]{16,}/,
  /mysql:\/\/[^\s:@]+:[^\s@]+@/i,
  /AKIA[0-9A-Z]{16}/,
];
for (const pattern of forbiddenSecretPatterns) {
  if (pattern.test(serialized)) fail('Potential secret detected in video generation request');
}

console.log(JSON.stringify({
  requestId: request.requestId,
  capabilityId: request.capabilityId,
  shots: shots.length,
  plannedDurationSeconds: plannedDuration,
  targetDurationSeconds: target.durationSeconds,
  identityLockRequired: continuity.identityLockRequired === true,
  criticalTextProtected: textPolicy.criticalOnScreenTextAllowedInGeneration === false,
  maximumActiveMotionPerShot: Math.max(...shots.map(shot => shot.activeMotionCount)),
  postGenerationSpecId: qualityPolicy.postGenerationSpecId,
  status: 'VIDEO_GENERATION_REQUEST_PASS',
}, null, 2));
