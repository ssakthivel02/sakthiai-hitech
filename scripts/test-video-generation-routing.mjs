import { execFileSync } from 'node:child_process';

const fixture = 'research/generative-media/fixtures/video-generation-request-pass.json';
const stdout = execFileSync(process.execPath, ['scripts/route-video-generation-candidates.mjs', fixture], { encoding: 'utf8' });
const result = JSON.parse(stdout);

if (result.policy?.researchOnly !== true) throw new Error('Routing result must remain research-only');
if (result.policy?.ranked !== false) throw new Error('Routing result must not rank providers');
if (result.policy?.paidProviderApproved !== false || result.policy?.productionApproved !== false) {
  throw new Error('Routing result cannot approve paid-provider or production use');
}

const eligibleIds = (result.eligibleCandidates ?? []).map(item => item.providerId);
if (eligibleIds.length !== 1 || eligibleIds[0] !== 'GOOGLE_GEMINI_VEO_3_1') {
  throw new Error(`Expected only GOOGLE_GEMINI_VEO_3_1 to satisfy the verified fixture requirements; got ${eligibleIds.join(', ') || 'none'}`);
}

const runway = (result.evaluated ?? []).find(item => item.providerId === 'RUNWAY_GEN_4_5');
if (!runway || runway.eligible !== false) throw new Error('RUNWAY_GEN_4_5 must remain ineligible for this fixture based on current verified evidence');
if (!runway.reasons.some(reason => reason.includes('target height'))) throw new Error('Runway ineligibility must preserve verified resolution mismatch evidence');
if (!runway.reasons.some(reason => reason.includes('generated audio'))) throw new Error('Runway ineligibility must preserve unverified audio requirement evidence');

const sora = (result.evaluated ?? []).find(item => item.providerId === 'OPENAI_SORA_2_API');
if (!sora || sora.eligible !== false) throw new Error('Sunsetting Sora API must never be eligible for new routing');
if (!sora.reasons.some(reason => reason.includes('EXCLUDED_SUNSET_IMMINENT'))) throw new Error('Sora exclusion reason must preserve sunset state');

console.log(JSON.stringify({
  status: 'VIDEO_ROUTING_TEST_PASS',
  requestId: result.requestId,
  eligibleCandidates: eligibleIds,
  excludedSunsettingProvider: sora.providerId,
  ranked: result.policy.ranked,
}, null, 2));
