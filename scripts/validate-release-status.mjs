import fs from 'node:fs';

/**
 * Validates release/release-status.json (rendered publicly on /intelligence).
 * Fails when a layer claims runtime health without dated evidence, when a blocked layer has no blocker,
 * when production is shown as go while the capability contract says production is not approved,
 * or when the public file contains infrastructure identifiers (hostnames, service ids, addresses, e-mail).
 */
const file = process.argv[2] || 'release/release-status.json';
const contractFile = process.argv[3] || 'release/beta-capability-contract.json';
const raw = fs.readFileSync(file, 'utf8');
const data = JSON.parse(raw);
const contract = JSON.parse(fs.readFileSync(contractFile, 'utf8'));
const states = new Set(['planned', 'source_implemented', 'ci_passed', 'live_verified', 'deployed', 'blocked', 'unknown']);
const verdicts = new Set(['go', 'no-go']);
const sha = /^[0-9a-f]{40}$/;
const fail = message => { throw new Error(`release-status: ${message}`); };

const forbidden = [
  [/\.onrender\.com|\.aivencloud\.com|\.internal\b|\.local\b|\.lan\b/i, 'infrastructure hostname'],
  [/\bsrv-[a-z0-9]{10,}|\btea-[a-z0-9]{10,}|\bdep-[a-z0-9]{10,}/i, 'hosting service/workspace/deploy identifier'],
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i, 'e-mail address'],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/, 'IP address'],
  [/(?:password|secret|token|api[_-]?key)\s*[:=]/i, 'credential-like assignment'],
];
for (const [pattern, what] of forbidden) if (pattern.test(raw)) fail(`public ledger contains ${what}`);

if (!Date.parse(data.observedAt)) fail('observedAt must be an ISO timestamp');
if (!(Number.isInteger(data.freshnessDays) && data.freshnessDays > 0 && data.freshnessDays <= 30)) fail('freshnessDays must be an integer 1..30');
for (const tier of ['preview', 'production']) if (!verdicts.has(data.verdicts?.[tier])) fail(`verdicts.${tier} must be go or no-go`);
if (data.verdicts.production === 'go' && contract.productionApproved !== true) fail('production cannot be go while the capability contract has productionApproved=false');
if (!sha.test(data.candidate?.lastCiVerifiedCommit ?? '')) fail('candidate.lastCiVerifiedCommit must be a full SHA');
if (!data.candidate?.ciEvidence) fail('candidate.ciEvidence required');
if (data.deployment?.observedCommit !== 'unknown' && !sha.test(data.deployment?.observedCommit ?? '')) fail('deployment.observedCommit must be a full SHA or "unknown"');
if (!Date.parse(data.deployment?.observedAt)) fail('deployment.observedAt must be an ISO timestamp');
for (const link of [data.candidate.link, data.dashboardLink]) if (!/^https:\/\/github\.com\/ssakthivel02\/sakthiai-hitech\//.test(link ?? '')) fail(`links must point at the public repository: ${link}`);

if (!Array.isArray(data.layers) || data.layers.length === 0) fail('layers required');
const ids = new Set();
let healthy = 0;
for (const layer of data.layers) {
  if (!layer.id || ids.has(layer.id)) fail(`invalid/duplicate layer id ${layer.id}`);
  ids.add(layer.id);
  if (!states.has(layer.state)) fail(`${layer.id}: invalid state ${layer.state}`);
  if (!layer.evidence || layer.evidence.length < 20) fail(`${layer.id}: evidence sentence required`);
  if (layer.state === 'blocked' && !(layer.blocker && layer.blocker.length >= 10)) fail(`${layer.id}: blocked requires a blocker`);
  if (layer.state === 'live_verified' || layer.state === 'deployed') {
    healthy += 1;
    if (!Date.parse(layer.verifiedAt ?? '')) fail(`${layer.id}: ${layer.state} requires verifiedAt`);
  }
}
if (data.verdicts.preview === 'go' && data.layers.some(l => l.state === 'blocked' || l.state === 'unknown')) fail('preview cannot be go with blocked or unknown layers');

console.log(`Release status valid: ${data.layers.length} layers; ${healthy} runtime-verified; preview ${data.verdicts.preview}; production ${data.verdicts.production}.`);
