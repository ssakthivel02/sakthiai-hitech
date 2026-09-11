import fs from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("Usage: node scripts/validate-db-recovery-contract.mjs <contract.json>");
  process.exit(2);
}

const contract = JSON.parse(fs.readFileSync(file, "utf8"));
const errors = [];
const requiredTrue = [
  "exactDatabaseIdentityRequired",
  "verifiedTlsRequired",
  "preMigrationBackupRequired",
  "backupIntegrityEvidenceRequired",
  "migrationPlanRequired",
  "destructiveMigrationRequiresExplicitApproval",
  "restoreProcedureRequired",
  "restoreVerificationRequired",
  "postRestoreReadinessCheckRequired",
  "ownerApprovalRequired",
];

if (contract.schemaVersion !== "1.0.0") errors.push("schemaVersion must be 1.0.0");
if (contract.scope !== "controlled-preview") errors.push("scope must be controlled-preview");
if (contract.databaseEngine !== "mysql") errors.push("databaseEngine must be mysql");
if (typeof contract.expectedDatabaseName !== "string" || contract.expectedDatabaseName.trim().length === 0) {
  errors.push("expectedDatabaseName must be non-empty");
}

for (const key of requiredTrue) {
  if (contract.requirements?.[key] !== true) errors.push(`${key} must be true`);
}
if (contract.requirements?.productionAutomaticRestoreAllowed !== false) {
  errors.push("productionAutomaticRestoreAllowed must be false");
}

const requiredEvidence = new Set(contract.requiredEvidence ?? []);
for (const item of [
  "exact database name",
  "TLS CA verification",
  "backup identifier and creation time",
  "backup integrity verification",
  "migration command and exact candidate commit",
  "migration compatibility assessment",
  "restore target and restore procedure",
  "post-restore database identity verification",
  "post-restore application readiness verification",
  "explicit owner approval",
]) {
  if (!requiredEvidence.has(item)) errors.push(`missing required evidence: ${item}`);
}

const forbidden = new Set(contract.forbiddenClaimsWithoutRuntimeEvidence ?? []);
for (const claim of [
  "migration complete",
  "backup verified",
  "restore verified",
  "preview database ready",
  "production database ready",
]) {
  if (!forbidden.has(claim)) errors.push(`missing forbidden unevidenced claim: ${claim}`);
}

if (errors.length) {
  console.error("Database recovery contract validation failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log("Database recovery contract validation passed.");
