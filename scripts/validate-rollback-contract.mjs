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
requireFalse(contract.release?.productionApproved, 'Rollback contract cannot approve production');
requireFalse(contract.release?.paidProviderActivationApproved, 'Rollback contract cannot approve paid providers');
requireFalse(contract.release?.dnsChangeApproved, 'Rollback contract cannot approve DNS changes');

console.log(JSON.stringify({
  status: 'ROLLBACK_CONTRACT_PASS',
  environment: contract.environment,
  strategy: contract.rollback.strategy,
  verificationEndpoints: requiredEndpoints,
  productionApproved: contract.release.productionApproved,
}, null, 2));
