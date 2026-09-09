import fs from 'node:fs';

const files = [
  'research/intelligence/gemini-two-month-ingestion-ledger.json',
  'research/document-rag/architecture-registry.json',
  'research/evaluation/benchmark-registry.json',
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
if (ledger?.policy?.noNewSchedules !== true) throw new Error('Two-month ingestion ledger must preserve no-new-schedules policy.');
if (ledger?.policy?.primarySourceReverificationBeforeRuntime !== true) throw new Error('Primary-source reverification policy missing.');

console.log(`INTELLIGENCE_RESEARCH_GATE_PASS stableIds=${ids.size} files=${files.length}`);
