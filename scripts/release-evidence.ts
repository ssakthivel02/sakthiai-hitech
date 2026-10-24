// Consolidates every gate's evidence into reports/release/release-evidence.json for the EXACT checked-out commit.
// Usage: tsx scripts/release-evidence.ts [--out path] [--require-pass] [--require-ci]
//   --require-pass  exit 1 on any FAIL or MISSING gate
//   --require-ci    additionally exit 1 unless every gate is PASS/ATTESTED inside GitHub Actions (never true locally)
import { execSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildManifest, checkCapabilityMap, checkMigrations, fileDigest, readJson, summarizeAudit, summarizePlaywright, summarizeVitest } from "../server/release/evidence";

const arg = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const OUT = arg("--out") ?? "reports/release/release-evidence.json";
const sh = (cmd: string) => { try { return execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { return ""; } };
const script = (file: string, args: string[] = []) => { const r = spawnSync("node", [file, ...args], { encoding: "utf8" }); return { ok: r.status === 0, detail: ((r.stdout || "") + (r.stderr || "")).trim().split("\n").pop() ?? "" }; };

const actions = process.env.GITHUB_ACTIONS === "true";
const manifest = buildManifest({
  gitSha: sh("git rev-parse HEAD") || "unknown", gitDirty: sh("git status --porcelain").length > 0, node: process.version, pnpm: sh("pnpm --version"), generatedAt: new Date().toISOString(),
  ci: { actions, runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT, workflow: process.env.GITHUB_WORKFLOW, ref: process.env.GITHUB_REF, sha: process.env.GITHUB_SHA, upstreamJobsSucceeded: (process.env.RELEASE_UPSTREAM_JOBS_SUCCEEDED ?? "").split(",").map(s => s.trim()).filter(Boolean) },
  files: { lockfile: fileDigest("pnpm-lock.yaml"), packageJson: fileDigest("package.json") },
  migrations: checkMigrations("."), capability: checkCapabilityMap(readJson("SAKTHIAI_CAPABILITY_IMPLEMENTATION_MAP.json") ?? {}, "."),
  unit: summarizeVitest(readJson("reports/unit/vitest-report.json")), mysql: summarizeVitest(readJson("reports/mysql/vitest-report.json")), e2e: summarizePlaywright(readJson("reports/e2e/playwright-report.json")), audit: summarizeAudit(readJson("reports/audit/audit-prod.json")),
  evalReport: readJson("reports/evals/eval-report.json"), goldenReport: readJson("reports/evals/golden-benchmark.json"), recoveryReport: readJson("reports/recovery/recovery-report.json"), smoke: readJson("reports/release/smoke.json"),
  evalDigest: fileDigest("reports/evals/eval-report.json"), goldenDigest: fileDigest("reports/evals/golden-benchmark.json"), e2eDigest: fileDigest("reports/e2e/playwright-report.json"), recoveryDigest: fileDigest("reports/recovery/recovery-report.json"),
  secretHygiene: script("scripts/validate-secret-hygiene.mjs"), sourceNeutrality: (() => { const a = script("scripts/validate-source-neutrality.mjs"); const d = script("scripts/validate-source-neutrality.mjs", ["--dist"]); return { ok: a.ok && d.ok, detail: `${a.detail} | ${d.detail}` }; })(),
});
mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(manifest, null, 2)}\n`);
const g = Object.entries(manifest.gates).map(([k, v]) => `${k}=${v.status}`).join(" ");
console.log(`RELEASE_EVIDENCE sha=${manifest.source.gitSha.slice(0, 12)} overall=${manifest.summary.overall} ci=${manifest.claims.CI_STATUS} runtime=${manifest.claims.RUNTIME_STATUS} locallyTested=${manifest.claims.LOCALLY_TESTED}\n${g}`);
const bad = manifest.summary.overall === "GATES_FAILED" || manifest.summary.overall === "GATES_INCOMPLETE";
if (process.argv.includes("--require-ci") && manifest.summary.overall !== "CI_GATES_PASS") { console.error(`RELEASE_EVIDENCE_FAIL: not CI_GATES_PASS (${manifest.summary.overall}); failed=[${manifest.summary.failed}] missing=[${manifest.summary.missing}] notAttested=[${manifest.summary.notAttested}]`); process.exit(1); }
if (process.argv.includes("--require-pass") && bad) { console.error(`RELEASE_EVIDENCE_FAIL: ${manifest.summary.overall}; failed=[${manifest.summary.failed}] missing=[${manifest.summary.missing}]`); process.exit(1); }
