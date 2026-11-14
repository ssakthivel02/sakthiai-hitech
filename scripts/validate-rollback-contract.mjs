import fs from 'node:fs';

const path = process.argv[2] || 'release/rollback-contract.json';
const contract = JSON.parse(fs.readFileSync(path, 'utf8'));

function requireTrue(value, message) {
  if (value !== true) throw new Error(message);
}

function requireFalse(value, message) {
  if (value !== false) throw new Error(message);
}

function requireEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}: expected ${expected}, got ${actual}`);
}

requireEqual(contract.schemaVersion, 1, 'Unsupported rollback contract schema');
requireEqual(contract.application, 'sakthiai-hitech', 'Application mismatch');
requireEqual(contract.environment, 'preview', 'Rollback contract must remain preview-scoped');
requireEqual(contract.canonicalRepository, 'ssakthivel02/sakthiai-hitech', 'Canonical repository mismatch');
requireEqual(contract.sourcePolicy, 'exact-commit-only-after-green-gates', 'Unsafe source policy');
requireEqual(contract.rollback?.strategy, 'redeploy-previous-known-good-commit', 'Unsupported rollback strategy');

for (const [field, value] of Object.entries({
  operatorApprovalRequired: contract.rollback?.operatorApprovalRequired,
  requirePreviousCommitSha: contract.rollback?.requirePreviousCommitSha,
  requireImmutableBuildEvidence: contract.rollback?.requireImmutableBuildEvidence,
  requireReleaseIdentityMatch: contract.rollback?.requireReleaseIdentityMatch,
  requireDatabaseBackupEvidence: contract.rollback?.requireDatabaseBackupEvidence,
  requireMigrationCompatibilityOrRestorePlan: contract.rollback?.requireMigrationCompatibilityOrRestorePlan,
  requirePostRollbackHealth: contract.rollback?.requirePostRollbackHealth,
  requirePostRollbackReadiness: contract.rollback?.requirePostRollbackReadiness,
  requirePostRollbackReleaseIdentity: contract.rollback?.requirePostRollbackReleaseIdentity,
})) {
  requireTrue(value, `${field} must be explicitly true`);
}

requireFalse(contract.rollback?.automaticProductionRollback, 'Automatic production rollback must remain disabled');

const requiredEndpoints = ['/healthz', '/readyz', '/releasez'];
const endpoints = Array.isArray(contract.verificationEndpoints) ? contract.verificationEndpoints : [];
for (const endpoint of requiredEndpoints) {
  if (!endpoints.includes(endpoint)) throw new Error(`Missing rollback verification endpoint: ${endpoint}`);
}

requireEqual(contract.database?.expectedDatabase, 'sakthiai_preview', 'Wrong rollback database target');
requireTrue(contract.database?.restoreRequiredForDestructiveOrIncompatibleMigration, 'Destructive/incompatible migrations must require restore');
requireFalse(contract.database?.allowSchemaGuessing, 'Schema guessing must remain disabled');
const sha = /^[0-9a-f]{40}$/;
if (!sha.test(contract.securityBaseline?.minimumCommit ?? '')) throw new Error('securityBaseline.minimumCommit must be a full commit SHA');
const forbidden = Array.isArray(contract.securityBaseline?.forbiddenTargets) ? contract.securityBaseline.forbiddenTargets : [];
for (const f of forbidden) if (!sha.test(f?.commit ?? '') || !f?.reason) throw new Error('Each forbidden rollback target needs a full SHA and a reason');
if (forbidden.some(f => f.commit === contract.securityBaseline.minimumCommit)) throw new Error('The security baseline cannot also be a forbidden target');
const containment = Array.isArray(contract.containment?.whenNoQualifiedTarget) ? contract.containment.whenNoQualifiedTarget : [];
if (!containment.length || containment.some(c => !['suspend-service', 'maintenance-mode'].includes(c))) throw new Error('containment.whenNoQualifiedTarget must list suspend-service and/or maintenance-mode only');
requireTrue(contract.containment?.neverServeForbiddenTarget, 'A forbidden target must never be served as containment');
if (containment.includes('maintenance-mode')) {
  const m = contract.containment?.maintenanceMode;
  requireEqual(m?.mechanism, 'application', 'Maintenance mode must be the tested application mechanism, not an assumed platform feature');
  requireEqual(m?.variable, 'SAKTHIAI_MAINTENANCE_MODE', 'Maintenance mode variable mismatch');
  if (!m?.test || !fs.existsSync(m.test)) throw new Error('Maintenance mode containment needs its test file');
  const notAvailable = Array.isArray(m?.notAvailableOn) ? m.notAvailableOn : [];
  for (const f of forbidden) if (!notAvailable.includes(f.commit)) throw new Error(`Forbidden target ${f.commit} predates maintenance mode and must be listed in maintenanceMode.notAvailableOn`);
}
const build = contract.buildEvidence;
if (!build?.manifest || !build?.servedIdentity || !build?.retainedArtifact || !build?.doc || !fs.existsSync(build.doc)) throw new Error('requireImmutableBuildEvidence needs buildEvidence (manifest, servedIdentity, retainedArtifact, doc)');
requireTrue(contract.database?.applicationRollbackSeparateFromRestore, 'Application rollback must be separate from database restore');
requireTrue(contract.database?.targetJournalMustBePrefixOfLiveJournal, 'A rollback target must expect a schema the live database already satisfies');
requireFalse(contract.release?.productionApproved, 'Rollback contract cannot approve production');
requireFalse(contract.release?.paidProviderActivationApproved, 'Rollback contract cannot approve paid providers');
requireFalse(contract.release?.dnsChangeApproved, 'Rollback contract cannot approve DNS changes');

console.log(JSON.stringify({
  status: 'ROLLBACK_CONTRACT_PASS',
  environment: contract.environment,
  strategy: contract.rollback.strategy,
  securityBaseline: contract.securityBaseline.minimumCommit,
  containment: containment,
  buildEvidence: contract.buildEvidence.retainedArtifact,
  verificationEndpoints: requiredEndpoints,
  productionApproved: contract.release.productionApproved,
}, null, 2));
