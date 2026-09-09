import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const registryPath = path.join(ROOT, 'research/generative-media/capability-registry.json');
const contractPath = path.join(ROOT, 'research/generative-media/studio-contracts.json');
const evidenceSchemaPath = path.join(ROOT, 'research/generative-media/evidence.schema.json');
const videoProviderEvidencePath = path.join(ROOT, 'research/generative-media/video-provider-evidence.json');

const fail = (message) => {
  console.error(`GENERATIVE_MEDIA_GATE_FAIL: ${message}`);
  process.exitCode = 1;
};

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`${path.relative(ROOT, file)} is not valid JSON: ${error.message}`);
    return null;
  }
};

for (const file of [registryPath, contractPath, evidenceSchemaPath, videoProviderEvidencePath]) {
  if (!fs.existsSync(file)) fail(`required file missing: ${path.relative(ROOT, file)}`);
}

if (process.exitCode) process.exit(process.exitCode);

const registry = readJson(registryPath);
const contracts = readJson(contractPath);
const evidenceSchema = readJson(evidenceSchemaPath);
const videoProviderEvidence = readJson(videoProviderEvidencePath);
if (!registry || !contracts || !evidenceSchema || !videoProviderEvidence) process.exit(1);

if (registry.policy?.providerNeutral !== true) fail('registry.policy.providerNeutral must be true');
if (registry.policy?.productionApproval !== false) fail('research registry must not grant production approval');
if (registry.policy?.paidProviderActivation !== false) fail('research registry must not activate paid providers');
if (!Array.isArray(registry.capabilities) || registry.capabilities.length === 0) fail('capabilities must be a non-empty array');

const allowedSurfaces = new Set(['web', 'server', 'mobile-api']);
const capabilityIds = new Set();
const consentSensitivePrefixes = new Set([
  'GM-AVATAR', 'GM-TALKPHOTO', 'GM-DTWIN', 'GM-VOICEDESIGN',
  'GM-VOICECLONE', 'GM-S2S', 'GM-LIPSYNC'
]);

for (const capability of registry.capabilities ?? []) {
  if (!/^GM-[A-Z0-9-]+$/.test(capability.id ?? '')) fail(`invalid capability id: ${capability.id}`);
  if (capabilityIds.has(capability.id)) fail(`duplicate capability id: ${capability.id}`);
  capabilityIds.add(capability.id);
  if (typeof capability.name !== 'string' || capability.name.trim().length < 3) fail(`${capability.id}: invalid name`);
  if (!Array.isArray(capability.surfaces) || capability.surfaces.length === 0) fail(`${capability.id}: surfaces required`);
  for (const surface of capability.surfaces ?? []) {
    if (!allowedSurfaces.has(surface)) fail(`${capability.id}: unsupported surface ${surface}`);
  }
  if (consentSensitivePrefixes.has(capability.id) && capability.consentRequired !== true) {
    fail(`${capability.id}: consentRequired must be true`);
  }
}

if (!Array.isArray(contracts.capabilityContracts) || contracts.capabilityContracts.length === 0) {
  fail('studio contracts must contain capabilityContracts');
}

const allowedStages = new Set(['research', 'proposed', 'prototype', 'preview', 'production']);
const allowedVerification = new Set(['HISTORICAL', 'NEEDS_VERIFICATION', 'VERIFIED_CURRENT', 'UNKNOWN']);
const contractIds = new Set();
for (const contract of contracts.capabilityContracts ?? []) {
  if (!capabilityIds.has(contract.capabilityId)) fail(`contract references unknown capability: ${contract.capabilityId}`);
  if (contractIds.has(contract.capabilityId)) fail(`duplicate studio contract: ${contract.capabilityId}`);
  contractIds.add(contract.capabilityId);
  if (!allowedStages.has(contract.lifecycleStage)) fail(`${contract.capabilityId}: invalid lifecycleStage`);
  if (!allowedVerification.has(contract.verificationStatus)) fail(`${contract.capabilityId}: invalid verificationStatus`);
  if (contract.enabled !== false && contract.lifecycleStage === 'research') fail(`${contract.capabilityId}: research capability cannot be enabled`);
  if (contract.providerBinding !== null) fail(`${contract.capabilityId}: providerBinding must remain null in provider-neutral baseline`);
  if (contract.paidProviderApproved !== false) fail(`${contract.capabilityId}: paidProviderApproved must be false`);
  if (contract.productionApproved !== false) fail(`${contract.capabilityId}: productionApproved must be false`);
}

for (const capabilityId of capabilityIds) {
  if (!contractIds.has(capabilityId)) fail(`missing studio contract for ${capabilityId}`);
}

if (videoProviderEvidence.status !== 'current-primary-source-evidence') fail('video provider evidence must declare current-primary-source-evidence status');
if (!/^\d{4}-\d{2}-\d{2}$/.test(videoProviderEvidence.lastVerifiedDate ?? '')) fail('video provider evidence requires lastVerifiedDate');
if (videoProviderEvidence.policy?.providerNeutral !== true) fail('video provider evidence must remain provider-neutral');
if (videoProviderEvidence.policy?.researchOnly !== true) fail('video provider evidence must remain research-only');
if (videoProviderEvidence.policy?.productionApproved !== false) fail('video provider evidence cannot approve production');
if (videoProviderEvidence.policy?.paidProviderApproved !== false) fail('video provider evidence cannot approve paid providers');
if (videoProviderEvidence.policy?.noProviderRankingWithoutSakthiAIBenchmark !== true) fail('provider ranking must remain blocked until SakthiAI benchmark evidence exists');
if (videoProviderEvidence.policy?.deprecatedOrSunsettingProvidersExcludedFromNewIntegration !== true) fail('sunsetting providers must be excluded from new integration');

const providerIds = new Set();
let excludedSunsetCount = 0;
for (const provider of videoProviderEvidence.providers ?? []) {
  if (!/^[A-Z0-9_]+$/.test(provider.providerId ?? '')) fail(`invalid providerId: ${provider.providerId}`);
  if (providerIds.has(provider.providerId)) fail(`duplicate video provider evidence: ${provider.providerId}`);
  providerIds.add(provider.providerId);
  if (!provider.provider || !provider.product) fail(`${provider.providerId}: provider/product required`);
  if (provider.verificationState !== 'VERIFIED_CURRENT_PRIMARY') fail(`${provider.providerId}: verificationState must be VERIFIED_CURRENT_PRIMARY`);
  if (!['CANDIDATE_RESEARCH_ONLY', 'EXCLUDED_SUNSET_IMMINENT'].includes(provider.integrationState)) fail(`${provider.providerId}: invalid integrationState`);
  if (provider.productionApproved !== false || provider.paidProviderApproved !== false) fail(`${provider.providerId}: research evidence cannot grant approvals`);
  if (!Array.isArray(provider.sourceUrls) || provider.sourceUrls.length === 0) fail(`${provider.providerId}: sourceUrls required`);
  for (const sourceUrl of provider.sourceUrls) {
    if (!/^https:\/\//.test(sourceUrl)) fail(`${provider.providerId}: source must use HTTPS`);
  }
  if (!provider.verifiedFacts || typeof provider.verifiedFacts !== 'object') fail(`${provider.providerId}: verifiedFacts required`);
  if (!Array.isArray(provider.sakthiaiRoutingSignals)) fail(`${provider.providerId}: sakthiaiRoutingSignals must be an array`);
  if (provider.integrationState === 'EXCLUDED_SUNSET_IMMINENT') {
    excludedSunsetCount += 1;
    if (provider.sakthiaiRoutingSignals.length !== 0) fail(`${provider.providerId}: excluded sunsetting provider cannot expose routing signals`);
    if (!provider.verifiedFacts.apiSunsetDate) fail(`${provider.providerId}: excluded sunsetting provider requires apiSunsetDate`);
  }
}
if (providerIds.size < 2) fail('video provider evidence requires at least two independently verified provider records');
if (excludedSunsetCount < 1) fail('video provider evidence should explicitly preserve known sunset exclusion evidence when present');

const serialized = JSON.stringify({ registry, contracts, evidenceSchema, videoProviderEvidence });
const forbiddenSecretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /ghp_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /sk-[A-Za-z0-9]{20,}/,
  /mysql(?:2)?:\/\/[^:@\s]+:[^@\s]+@/i,
  /AKIA[0-9A-Z]{16}/
];
for (const pattern of forbiddenSecretPatterns) {
  if (pattern.test(serialized)) fail(`possible secret detected by ${pattern}`);
}

if (contracts.policy?.sourceResearchIsNotRuntimeTruth !== true) fail('sourceResearchIsNotRuntimeTruth must be true');
if (contracts.policy?.primarySourceReverificationRequired !== true) fail('primarySourceReverificationRequired must be true');
if (contracts.policy?.mobileConsumesServerContracts !== true) fail('mobileConsumesServerContracts must be true');
if (contracts.policy?.noVendorLockIn !== true) fail('noVendorLockIn must be true');

if (process.exitCode) process.exit(1);
console.log(`GENERATIVE_MEDIA_GATE_PASS capabilities=${capabilityIds.size} contracts=${contractIds.size} videoProviders=${providerIds.size} excludedSunsets=${excludedSunsetCount}`);
