#!/usr/bin/env node
// Runs every *.mysql.test.ts against a REAL MySQL-compatible server. Absence of TEST_DATABASE_URL is a failure, never a skip.
import { spawnSync } from "node:child_process";
if (!process.env.TEST_DATABASE_URL) {
  console.error("MYSQL_TESTS_FAIL: TEST_DATABASE_URL is required, e.g. mysql://root:pw@127.0.0.1:3306 (server-level credentials; a throwaway database is created and dropped per suite)");
  process.exit(2);
}
const run = spawnSync("pnpm", ["exec", "vitest", "run", "--reporter=default", "--reporter=json", "--outputFile=reports/mysql/vitest-report.json", "mysql.test"], { stdio: "inherit", env: { ...process.env, MYSQL_REQUIRED: "1" } });
process.exit(run.status ?? 1);
