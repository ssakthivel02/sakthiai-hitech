import fs from 'node:fs';

const files = [
  'research/intelligence/gemini-two-month-ingestion-ledger.json',
  'research/document-rag/architecture-registry.json',
  'research/evaluation/benchmark-registry.json',
  'research/evaluation/video-quality-spec.json',
  'research/evaluation/video-quality-remediation-map.json',
  'research/security/threat-control-registry.json',
];

const parsed = new Map();
for (const file of files) {
  if (!fs.existsSync(file)) throw new Error(`Missing intelligence research file: ${file}`);
  parsed.set(file, JSON.parse(fs.readFileSync(file, 'utf8')));
}

const forbiddenSecretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /github_pat_[A-Za-z0-9_]+/,
  /ghp_[A-Za-z0-9]+/,
  /sk-[A-Za-z0-9]{16,}/,
  /mysql:\/\/[^\s:@]+:[^\s@]+@/i,
  /AKIA[0-9A-Z]{16}/,
];

const ids = new Set();
function registerId(id, where) {
  if (typeof id !== 'string' || !id.trim()) throw new Error(`Missing stable ID in ${where}`);
  if (ids.has(id)) throw new Error(`Duplicate stable ID across intelligence registries: ${id}`);
  ids.add(id);
}

for (const [file, value] of parsed) {
  const serialized = JSON.stringify(value);
  for (const pattern of forbiddenSecretPatterns) {
    if (pattern.test(serialized)) throw new Error(`Potential secret detected in ${file}`);
  }
  if (value.runtimeTruth === true) throw new Error(`${file} cannot declare research as runtime truth.`);
  if (value.runtimeApproved === true) throw new Error(`${file} cannot self-approve runtime use.`);
  if (value.productionApproved === true) throw new Error(`${file} cannot self-approve production use.`);
}

const rag = parsed.get('research/document-rag/architecture-registry.json');
for (const record of rag.records ?? []) {
  registerId(record.stableId, 'RAG registry');
  if (record.runtimeApproved !== false) throw new Error(`${record.stableId} must remain runtimeApproved=false`);
  if (!['HISTORICAL_SOURCE', 'NEEDS_CURRENT_VERIFICATION'].includes(record.verificationState)) {
    throw new Error(`${record.stableId} has invalid research verification state`);
  }
  if (!record.sourceTask || !record.retrievalDate || !record.confidence) throw new Error(`${record.stableId} missing provenance`);
}

const evaluation = parsed.get('research/evaluation/benchmark-registry.json');
for (const record of evaluation.sakthiaiOwnedSpecifications ?? []) {
  registerId(record.stableId, 'evaluation registry');
  if (record.runtimeApproved !== false) throw new Error(`${record.stableId} must remain runtimeApproved=false`);
  if (record.verificationState !== 'SOURCE_DEFINED_SPEC') throw new Error(`${record.stableId} must remain SOURCE_DEFINED_SPEC until implemented and verified`);
}
if (evaluation.rules?.neverFabricateScores !== true) throw new Error('Evaluation registry must forbid fabricated scores.');

const video = parsed.get('research/evaluation/video-quality-spec.json');
registerId(video.stableId, 'video quality specification');
if (video.verificationState !== 'SOURCE_DEFINED_SPEC') throw new Error('Video quality specification must remain SOURCE_DEFINED_SPEC.');
if (video.runtimeApproved !== false || video.productionApproved !== false) throw new Error('Video quality specification cannot self-approve runtime or production use.');
if (video.policy?.providerNeutral !== true) throw new Error('Video quality specification must remain provider-neutral.');
if (video.policy?.neverFabricateScores !== true) throw new Error('Video quality specification must forbid fabricated scores.');
if (video.policy?.humanReviewRequiredForPublishCandidate !== true) throw new Error('Publish-candidate video must require human review.');
if (video.policy?.tamilQualityRequiresHumanEvaluation !== true) throw new Error('Tamil video quality must require human evaluation.');
if (video.policy?.paidProviderActivation !== false) throw new Error('Video-quality research cannot activate paid providers.');
const qualityDimensions = video.sakthiaiAcceptanceDimensions ?? [];
if (qualityDimensions.length < 8) throw new Error('Video quality specification requires the complete acceptance dimension set.');
const totalWeight = qualityDimensions.reduce((sum, dimension) => sum + Number(dimension.weight ?? 0), 0);
if (totalWeight !== 100) throw new Error(`Video quality dimension weights must total 100; got ${totalWeight}`);
for (const dimension of qualityDimensions) {
  registerId(dimension.id, 'video quality dimension');
  if (!dimension.name || !dimension.review) throw new Error(`${dimension.id} missing name/review guidance.`);
  if (!Number.isFinite(dimension.weight) || dimension.weight <= 0) throw new Error(`${dimension.id} has invalid weight.`);
}
if ((video.criticalDefects ?? []).length === 0) throw new Error('Video quality specification must define critical defects.');
if (video.acceptanceGates?.previewCandidate?.maximumCriticalDefects !== 0) throw new Error('Preview candidate must fail on any critical defect.');
if (video.acceptanceGates?.publishCandidate?.maximumCriticalDefects !== 0) throw new Error('Publish candidate must fail on any critical defect.');
if (video.acceptanceGates?.publishCandidate?.minimumWeightedScore <= video.acceptanceGates?.previewCandidate?.minimumWeightedScore) {
  throw new Error('Publish-candidate threshold must be stricter than preview-candidate threshold.');
}

const remediation = parsed.get('research/evaluation/video-quality-remediation-map.json');
if (remediation.specId !== video.stableId) throw new Error('Video remediation map must target the active video quality specification.');
if (remediation.providerNeutral !== true || remediation.runtimeApproved !== false) throw new Error('Video remediation map must remain provider-neutral and runtimeApproved=false.');
const remediationIds = Object.keys(remediation.remediationByDimension ?? {});
const qualityIds = qualityDimensions.map(dimension => dimension.id);
for (const id of qualityIds) {
  const guidance = remediation.remediationByDimension?.[id];
  if (!guidance) throw new Error(`Missing remediation guidance for ${id}`);
  if (!['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].includes(guidance.priority)) throw new Error(`${id} remediation has invalid priority`);
  if (!guidance.problem || !Array.isArray(guidance.actions) || guidance.actions.length < 2) throw new Error(`${id} remediation guidance is incomplete`);
}
for (const id of remediationIds) {
  if (!qualityIds.includes(id)) throw new Error(`Remediation map contains unknown quality dimension ${id}`);
}
for (const decision of video.decisionValues ?? []) {
  if (!remediation.decisionGuidance?.[decision]) throw new Error(`Missing remediation decision guidance for ${decision}`);
}

const security = parsed.get('research/security/threat-control-registry.json');
if (security.defensiveOnly !== true) throw new Error('Security registry must remain defensive-only.');
for (const record of security.records ?? []) {
  registerId(record.stableId, 'security registry');
  if (record.runtimeApproved !== false) throw new Error(`${record.stableId} must remain runtimeApproved=false`);
  if (!['HISTORICAL_SOURCE', 'NEEDS_CURRENT_VERIFICATION'].includes(record.verificationState)) {
    throw new Error(`${record.stableId} has invalid research verification state`);
  }
}

const ledger = parsed.get('research/intelligence/gemini-two-month-ingestion-ledger.json');
if (ledger?.source?.productionTruth !== false) throw new Error('Two-month source must remain productionTruth=false.');
if (ledger?.policy?.newSchedulesCreated !== false) throw new Error('Two-month ingestion ledger must preserve the no-new-schedules state.');
if (ledger?.policy?.requirePrimarySourceReverificationBeforeRuntimeUse !== true) throw new Error('Primary-source reverification policy missing.');
if (ledger?.policy?.paidProviderActivation !== false) throw new Error('Research ingestion cannot activate paid providers.');
if (ledger?.policy?.productionApproval !== false) throw new Error('Research ingestion cannot self-approve production use.');

for (const domain of ledger?.domains ?? []) {
  if (!domain.id || !domain.destination) throw new Error('Every intelligence domain requires id and destination.');
  if (!fs.existsSync(domain.destination)) {
    console.log(`INTELLIGENCE_DESTINATION_PENDING ${domain.id} ${domain.destination}`);
  }
}

console.log(`INTELLIGENCE_RESEARCH_GATE_PASS stableIds=${ids.size} files=${files.length}`);
