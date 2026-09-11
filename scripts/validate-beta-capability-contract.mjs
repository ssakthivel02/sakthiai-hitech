import fs from 'node:fs';

const file = process.argv[2] || 'release/beta-capability-contract.json';
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const allowed = new Set(['available', 'preview', 'coming-soon']);
const seen = new Set();

if (data.productionApproved !== false) throw new Error('productionApproved must remain false');
if (!Array.isArray(data.capabilities) || data.capabilities.length === 0) throw new Error('capabilities required');

for (const capability of data.capabilities) {
  if (!capability.id || seen.has(capability.id)) throw new Error(`invalid/duplicate capability id: ${capability.id}`);
  seen.add(capability.id);
  if (!allowed.has(capability.status)) throw new Error(`${capability.id}: invalid status`);
  const expected = capability.status === 'available' ? 'Available' : capability.status === 'preview' ? 'Preview' : 'Coming Soon';
  if (capability.publicLabel !== expected) throw new Error(`${capability.id}: publicLabel must match status`);
  if (!capability.reason || capability.reason.length < 20) throw new Error(`${capability.id}: evidence reason required`);
  if (!Array.isArray(capability.repositoryEvidence)) throw new Error(`${capability.id}: repositoryEvidence must be an array`);
  if (capability.status === 'available') {
    if (capability.runtimeEvidence !== true) throw new Error(`${capability.id}: available requires runtime evidence`);
    if (capability.ownerApproved !== true) throw new Error(`${capability.id}: available requires owner approval`);
    if (capability.repositoryEvidence.length === 0) throw new Error(`${capability.id}: available requires repository evidence`);
  }
}

console.log(`Beta capability contract valid: ${data.capabilities.length} capabilities; ${data.capabilities.filter(c => c.status === 'available').length} available.`);
