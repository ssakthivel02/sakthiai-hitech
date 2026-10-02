#!/usr/bin/env node
// Deterministic CONTRACT-HARNESS eval runner. No secrets, no network, no paid provider.
// Runs the eval suites, then independently re-reads the JSON report and fails on any threshold regression.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";

const REPORT = process.env.EVAL_REPORT_PATH ?? "reports/evals/eval-report.json";
if (existsSync(REPORT)) rmSync(REPORT);

// Never inherit provider credentials or endpoints: the evals must be hermetic.
const env = { ...process.env, EVAL_REPORT_PATH: REPORT };
for (const key of Object.keys(env)) if (/^(LLM_|LOCAL_LLM_|GATEWAY_|OPENAI_|GEMINI_|GOOGLE_|ANTHROPIC_|XAI_)/.test(key)) delete env[key];

const run = spawnSync("pnpm", ["exec", "vitest", "run", "server/evals"], { stdio: "inherit", env });
if (run.status !== 0) {
  console.error("EVALS_FAIL: eval/test suite failed");
  process.exit(run.status ?? 1);
}
if (!existsSync(REPORT)) {
  console.error(`EVALS_FAIL: report not produced at ${REPORT}`);
  process.exit(1);
}
const report = JSON.parse(readFileSync(REPORT, "utf8"));
const problems = [];
if (report.schema !== "sakthiai.eval-report/v1") problems.push("unexpected report schema");
if (report.evidenceClass !== "CONTRACT_HARNESS") problems.push("evidence class must be CONTRACT_HARNESS");
if (report.paidProviderCalls !== 0) problems.push("paid provider calls must be 0");
if (report.realModelQuality !== "NOT_MEASURED") problems.push("report must not claim real-model quality");
if (!report.thresholds?.passed) problems.push(...(report.thresholds?.failures ?? ["thresholds missing"]));
const a = report.aggregates;
console.log(`EVAL_SUMMARY cases=${a.cases} passed=${a.casesPassed} retrievalHitRate=${a.retrievalHitRate} citationCoverage=${a.citationCoverage} groundingAccuracy=${a.groundingStateAccuracy} policyViolations=${a.policyViolations} leaks=${a.crossWorkspaceLeaks} fallbacks=${a.fallbackCount} p95Ms=${a.fixtureLatencyMs.p95}`);
if (problems.length) {
  console.error(`EVALS_FAIL:\n - ${problems.join("\n - ")}`);
  process.exit(1);
}
console.log(`EVALS_PASS report=${REPORT} (CONTRACT_HARNESS; real-model quality NOT_MEASURED)`);
