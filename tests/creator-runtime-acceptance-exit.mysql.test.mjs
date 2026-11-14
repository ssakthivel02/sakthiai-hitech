// Real MySQL 8: `pnpm creator:runtime:acceptance` must terminate with its verdict's exit code once a database
// pool is open. Before the fix it printed BLOCKED/PASS and then hung on the open mysql2 pool, so an operator or
// a CI step saw a timeout instead of a failure. No storage or provider credentials are set: the expected verdict
// is BLOCKED (exit 1), never PASS, and no paid provider is reachable.
import { spawn } from "node:child_process";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createScratchDatabase, dropScratchDatabase } from "../server/recovery/rehearsal";
import { mysqlTestUrl, skipMysqlSuite } from "../server/testing/mysqlTestDb";

const root = path.resolve(import.meta.dirname, "..");
const EXIT_BUDGET_MS = 30_000;

function runAcceptance(env) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(root, "node_modules/tsx/dist/cli.mjs"), "scripts/creator-runtime-acceptance.ts"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", d => (output += d));
    child.stderr.on("data", d => (output += d));
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve({ code: null, timedOut: true, output }); }, EXIT_BUDGET_MS);
    child.on("exit", code => { clearTimeout(timer); resolve({ code, timedOut: false, output }); });
  });
}

describe.skipIf(skipMysqlSuite())("creator runtime acceptance terminates", { timeout: EXIT_BUDGET_MS + 15_000 }, () => {
  const cleanup = [];
  afterAll(async () => { for (const fn of cleanup.reverse()) await fn(); });

  it("exits 1 with BLOCKED (not a hang) when the database is configured but storage and providers are not", async () => {
    const base = mysqlTestUrl();
    const s = await createScratchDatabase(base, "sakthi_it");
    cleanup.push(() => dropScratchDatabase(base, s.name));
    const env = { ...process.env, DATABASE_URL: s.url, DATABASE_EXPECTED_NAME: s.name, NODE_ENV: "test" };
    for (const k of ["STORAGE_BUCKET", "STORAGE_ACCESS_KEY_ID", "STORAGE_SECRET_ACCESS_KEY", "GEMINI_API_KEY", "OPENAI_API_KEY", "OPENAI_BASE_URL", "GOOGLE_VEO_API_BASE"]) delete env[k];

    const result = await runAcceptance(env);

    expect(result.timedOut, `harness did not exit within ${EXIT_BUDGET_MS} ms; output:\n${result.output}`).toBe(false);
    expect(result.code).toBe(1);
    expect(result.output).toMatch(/BLOCKED: required Creator runtime acceptance checks are not all passing/);
    expect(result.output).not.toMatch(/PASS CREATOR_RUNTIME_ACCEPTANCE/);
  });
});
