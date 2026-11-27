#!/usr/bin/env node
// LOCAL backup/restore/rollback rehearsal. Needs a throwaway local MySQL-compatible server (TEST_DATABASE_URL); managed hosts are refused.
// Writes reports/recovery/recovery-report.json and fails if any scenario failed or the report overclaims.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";

const REPORT = process.env.RECOVERY_REPORT_PATH ?? "reports/recovery/recovery-report.json";
if (!process.env.TEST_DATABASE_URL) {
  console.error("RECOVERY_FAIL: TEST_DATABASE_URL is required (a throwaway LOCAL server; managed/live hosts are refused)");
  process.exit(2);
}
if (existsSync(REPORT)) rmSync(REPORT);
const run = spawnSync("pnpm", ["exec", "vitest", "run", "server/recovery/rehearsal.mysql.test.ts"], { stdio: "inherit", env: { ...process.env, MYSQL_REQUIRED: "1", RECOVERY_REPORT_PATH: REPORT } });
if (run.status !== 0) { console.error("RECOVERY_FAIL: rehearsal suite failed"); process.exit(run.status ?? 1); }
if (!existsSync(REPORT)) { console.error(`RECOVERY_FAIL: report not produced at ${REPORT}`); process.exit(1); }
const r = JSON.parse(readFileSync(REPORT, "utf8"));
const problems = [];
if (r.schema !== "sakthiai.recovery-rehearsal/v1") problems.push("unexpected report schema");
if (r.evidenceClass !== "LOCAL_REHEARSAL") problems.push("evidence class must be LOCAL_REHEARSAL");
for (const flag of ["managedDatabaseTouched", "aivenTouched", "productionDatabaseTouched"]) if (r[flag] !== false) problems.push(`${flag} must be false`);
if (r.schemaDowngrade !== "NOT_SUPPORTED_FORWARD_ONLY") problems.push("report must not claim a schema downgrade");
const need = ["full-cycle-latest", "restore-refusals", "interrupted-restore", "upgrade-old-backup-to-latest", "provider-policy-budget-preserved", "task-checkpoint-effect-preserved", "oauth-transactions-after-restore", "bad-migration-rollback", "forward-only-migrations"];
for (const name of need) if (!r.scenarios?.find(s => s.name === name && s.ok)) problems.push(`scenario missing or failed: ${name}`);
if (!r.passed) problems.push("report.passed is false");
console.log(`RECOVERY_SUMMARY scenarios=${r.scenarios.length} allOk=${r.scenarios.every(s => s.ok)} engine=${r.engine} migrations=${r.migrations.length} downgrade=${r.schemaDowngrade}`);
if (problems.length) { console.error(`RECOVERY_FAIL:\n - ${problems.join("\n - ")}`); process.exit(1); }
console.log(`RECOVERY_PASS report=${REPORT} (LOCAL_REHEARSAL on ${r.engine}; not a production RTO/RPO claim)`);
