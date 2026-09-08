import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const registryPath = path.join(ROOT, 'research/generative-media/capability-registry.json');
const contractPath = path.join(ROOT, 'research/generative-media/studio-contracts.json');
const evidenceSchemaPath = path.join(ROOT, 'research/generative-media/evidence.schema.json');

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

for (const file of [registryPath, contractPath, evidenceSchemaPath]) {
  if (!fs.existsSync(file)) fail(`required file missing: ${path.relative(ROOT, file)}`);
}

if (process.exitCode) process.exit(process.exitCode);

const registry = readJson(registryPath);
const contracts = readJson(contractPath);
const evidenceSchema = readJson(evidenceSchemaPath);
if (!registry || !contracts || !evidenceSchema) process.exit(1);

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

const serialized = JSON.stringify({ registry, contracts, evidenceSchema });
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
console.log(`GENERATIVE_MEDIA_GATE_PASS capabilities=${capabilityIds.size} contracts=${contractIds.size}`);
