#!/usr/bin/env node
// Deterministic CONTRACT-HARNESS eval runner. No secrets, no network, no paid provider.
// Runs the eval suites, then independently re-reads the JSON report and fails on any threshold regression.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";

const REPORT = process.env.EVAL_REPORT_PATH ?? "reports/evals/eval-report.json";
const GOLDEN = process.env.GOLDEN_REPORT_PATH ?? "reports/evals/golden-benchmark.json";
for (const path of [REPORT, GOLDEN, GOLDEN.replace(/\.json$/, ".md")]) if (existsSync(path)) rmSync(path);

// Never inherit provider credentials or endpoints: the evals must be hermetic.
const env = { ...process.env, EVAL_REPORT_PATH: REPORT, GOLDEN_REPORT_PATH: GOLDEN };
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
// Golden Tamil/code-switch benchmark: a SEPARATE report. It must never claim real-model quality or be merged with the contract report.
if (!existsSync(GOLDEN)) problems.push(`golden benchmark report not produced at ${GOLDEN}`);
else {
  const golden = JSON.parse(readFileSync(GOLDEN, "utf8"));
  if (golden.schema !== "sakthiai.golden-benchmark/v1") problems.push("unexpected golden schema");
  if (golden.evidenceClass !== "CONTRACT_HARNESS_GOLDEN") problems.push("golden evidence class must be CONTRACT_HARNESS_GOLDEN");
  if (golden.realModelQuality !== "REAL_MODEL_QUALITY_UNVERIFIED") problems.push("golden report must state REAL_MODEL_QUALITY_UNVERIFIED");
  if (golden.paidProviderCalls !== 0) problems.push("golden paid provider calls must be 0");
  if (!golden.thresholds?.passed) problems.push(...(golden.thresholds?.failures ?? ["golden thresholds missing"]).map(f => `golden: ${f}`));
  const g = golden.aggregates;
  console.log(`GOLDEN_SUMMARY scored=${g.scoredPassed}/${g.scoredCases} knownGaps=${g.knownGapCases} hitRate=${g.retrievalHitRate} mrr=${g.meanReciprocalRank} grounding=${g.groundingStateAccuracy} citationRecall=${g.citationRecall} leaks=${g.crossWorkspaceLeaks} digest=${golden.corpusDigest.slice(0, 12)} realModel=${golden.realModelQuality}`);
}
if (problems.length) {
  console.error(`EVALS_FAIL:\n - ${problems.join("\n - ")}`);
  process.exit(1);
}
console.log(`EVALS_PASS report=${REPORT} golden=${GOLDEN} (CONTRACT_HARNESS + CONTRACT_HARNESS_GOLDEN; real-model quality NOT_MEASURED / REAL_MODEL_QUALITY_UNVERIFIED)`);
