import { execFileSync } from 'node:child_process';

const output = execFileSync(process.execPath, [
  'scripts/plan-video-shot-regeneration.mjs',
  'research/generative-media/fixtures/video-generation-request-pass.json',
  'research/evaluation/fixtures/video-shot-review-selective-regeneration.json',
], { encoding: 'utf8' });

const result = JSON.parse(output);

if (result.decision !== 'REGENERATE_FAILED_SHOTS') {
  throw new Error(`Expected REGENERATE_FAILED_SHOTS, got ${result.decision}`);
}
if (result.policy?.selectiveRegeneration !== true) {
  throw new Error('Selective regeneration must remain enabled for isolated shot failures.');
}
if (result.policy?.productionApproved !== false || result.policy?.paidProviderApproved !== false) {
  throw new Error('Shot regeneration evidence cannot grant production or paid-provider approval.');
}
if (JSON.stringify(result.regenerateShotIds) !== JSON.stringify(['SHOT-002'])) {
  throw new Error(`Expected only SHOT-002 to regenerate; got ${JSON.stringify(result.regenerateShotIds)}`);
}
if (JSON.stringify(result.preserveShotIds) !== JSON.stringify(['SHOT-001', 'SHOT-003'])) {
  throw new Error(`Expected SHOT-001 and SHOT-003 preserved; got ${JSON.stringify(result.preserveShotIds)}`);
}
const failed = result.shotResults.find(item => item.shotId === 'SHOT-002');
if (!failed || failed.failedDimensions.map(item => item.dimension).sort().join(',') !== 'identity,temporal,visual') {
  throw new Error('SHOT-002 must identify temporal, identity and visual failures.');
}

console.log('VIDEO_SHOT_REGENERATION_GATE_PASS regenerate=SHOT-002 preserve=SHOT-001,SHOT-003');
