import { CORE_AI_BENCHMARK } from "./benchmark";
import { scoreEvaluation } from "./score";
import type { EvaluationObservation } from "./types";

/**
 * Deterministic CONTRACT-HARNESS evidence: it proves routing, retrieval, grounding-state, policy and
 * failure-handling contracts hold on fixed fixtures with replayed provider responses. It does NOT measure
 * real-model answer quality (no model is called) and must never be cited as such.
 */
export const EVAL_REPORT_SCHEMA = "sakthiai.eval-report/v1";
export const EVIDENCE_CLASS = "CONTRACT_HARNESS" as const;

export const EVAL_DIMENSIONS = [
  "english_grounded_retrieval",
  "tamil_grounded_retrieval",
  "mixed_tamil_english",
  "no_evidence",
  "provider_unavailable",
  "provider_timeout",
  "citation_consistency",
  "cross_workspace_isolation",
  "local_routing_policy",
  "external_opt_in_requirement",
  "budget_denial",
  "fallback_behaviour",
] as const;
export type EvalDimensionId = (typeof EVAL_DIMENSIONS)[number];

export type StepMetrics = {
  /** Evidence was expected to be found (hit-rate denominator). */
  retrievalExpected: boolean;
  /** Evidence was expected to be absent (no-evidence / foreign-workspace cases). */
  retrievalMissExpected: boolean;
  retrievalHit: boolean | null;
  citationCount: number;
  consistentCitations: number;
  groundingExpected: string;
  groundingActual: string;
  groundingCorrect: boolean;
  providerSelected: string | null;
  fallbackCount: number;
  policyViolations: number;
  timeoutExpected: boolean;
  timeoutClassified: boolean | null;
  reportedTokens: number | null;
  budgetDecision: "not_applicable" | "allowed" | `denied:${string}`;
  crossWorkspaceLeaks: number;
  fixtureLatencyMs: number;
};

export type CaseResult = {
  id: string;
  dimension: EvalDimensionId;
  description: string;
  passed: boolean;
  failures: string[];
  steps: StepMetrics[];
};

export type Aggregates = {
  cases: number;
  casesPassed: number;
  steps: number;
  retrievalHitRate: number | null;
  unexpectedRetrievalHits: number;
  citationCoverage: number | null;
  groundingStateAccuracy: number;
  policyViolations: number;
  crossWorkspaceLeaks: number;
  fallbackCount: number;
  timeoutClassificationRate: number | null;
  reportedTokenTotal: number;
  budgetDenials: number;
  fixtureLatencyMs: { p50: number; p95: number; max: number };
  perDimension: Record<string, { cases: number; passed: number }>;
};

const rate = (num: number, den: number) => (den === 0 ? null : num / den);
const percentile = (values: number[], p: number) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};

export function aggregate(results: readonly CaseResult[]): Aggregates {
  const steps = results.flatMap(result => result.steps);
  const retrievalSteps = steps.filter(step => step.retrievalExpected);
  const timeoutSteps = steps.filter(step => step.timeoutExpected);
  const citationCount = steps.reduce((sum, step) => sum + step.citationCount, 0);
  const consistent = steps.reduce((sum, step) => sum + step.consistentCitations, 0);
  const latencies = steps.map(step => step.fixtureLatencyMs);
  const perDimension: Aggregates["perDimension"] = {};
  for (const result of results) {
    const bucket = (perDimension[result.dimension] ??= { cases: 0, passed: 0 });
    bucket.cases += 1;
    if (result.passed) bucket.passed += 1;
  }
  return {
    cases: results.length,
    casesPassed: results.filter(result => result.passed).length,
    steps: steps.length,
    unexpectedRetrievalHits: steps.filter(step => step.retrievalMissExpected && step.retrievalHit).length,
    retrievalHitRate: rate(retrievalSteps.filter(step => step.retrievalHit).length, retrievalSteps.length),
    citationCoverage: rate(consistent, citationCount),
    groundingStateAccuracy: steps.length ? steps.filter(step => step.groundingCorrect).length / steps.length : 0,
    policyViolations: steps.reduce((sum, step) => sum + step.policyViolations, 0),
    crossWorkspaceLeaks: steps.reduce((sum, step) => sum + step.crossWorkspaceLeaks, 0),
    fallbackCount: steps.reduce((sum, step) => sum + step.fallbackCount, 0),
    timeoutClassificationRate: rate(timeoutSteps.filter(step => step.timeoutClassified).length, timeoutSteps.length),
    reportedTokenTotal: steps.reduce((sum, step) => sum + (step.reportedTokens ?? 0), 0),
    budgetDenials: steps.filter(step => step.budgetDecision.startsWith("denied")).length,
    fixtureLatencyMs: { p50: percentile(latencies, 50), p95: percentile(latencies, 95), max: Math.max(0, ...latencies) },
    perDimension,
  };
}

/** Regression thresholds. Every one is a hard contract, not a quality target. */
export const THRESHOLDS = {
  minCases: 20,
  minCasesPerDimension: 1,
  allCasesPass: true,
  retrievalHitRate: 1,
  unexpectedRetrievalHits: 0,
  citationCoverage: 1,
  groundingStateAccuracy: 1,
  policyViolations: 0,
  crossWorkspaceLeaks: 0,
  timeoutClassificationRate: 1,
  /** Generous: deterministic in-process fixtures only, guards against pathological regressions. */
  fixtureLatencyP95MaxMs: 2000,
} as const;

export function evaluateThresholds(results: readonly CaseResult[], aggregates: Aggregates): string[] {
  const failures: string[] = [];
  if (aggregates.cases < THRESHOLDS.minCases) failures.push(`cases:${aggregates.cases}<${THRESHOLDS.minCases}`);
  for (const dimension of EVAL_DIMENSIONS) {
    if ((aggregates.perDimension[dimension]?.cases ?? 0) < THRESHOLDS.minCasesPerDimension) failures.push(`dimension-uncovered:${dimension}`);
  }
  for (const result of results) if (!result.passed) failures.push(`case-failed:${result.id}:${result.failures.join("|")}`);
  if (aggregates.retrievalHitRate !== null && aggregates.retrievalHitRate < THRESHOLDS.retrievalHitRate) failures.push(`retrievalHitRate:${aggregates.retrievalHitRate}`);
  if (aggregates.retrievalHitRate === null) failures.push("retrievalHitRate:no-observations");
  if (aggregates.unexpectedRetrievalHits > THRESHOLDS.unexpectedRetrievalHits) failures.push(`unexpectedRetrievalHits:${aggregates.unexpectedRetrievalHits}`);
  if (aggregates.citationCoverage !== null && aggregates.citationCoverage < THRESHOLDS.citationCoverage) failures.push(`citationCoverage:${aggregates.citationCoverage}`);
  if (aggregates.citationCoverage === null) failures.push("citationCoverage:no-observations");
  if (aggregates.groundingStateAccuracy < THRESHOLDS.groundingStateAccuracy) failures.push(`groundingStateAccuracy:${aggregates.groundingStateAccuracy}`);
  if (aggregates.policyViolations > THRESHOLDS.policyViolations) failures.push(`policyViolations:${aggregates.policyViolations}`);
  if (aggregates.crossWorkspaceLeaks > THRESHOLDS.crossWorkspaceLeaks) failures.push(`crossWorkspaceLeaks:${aggregates.crossWorkspaceLeaks}`);
  if (aggregates.timeoutClassificationRate !== null && aggregates.timeoutClassificationRate < THRESHOLDS.timeoutClassificationRate) failures.push(`timeoutClassificationRate:${aggregates.timeoutClassificationRate}`);
  if (aggregates.fixtureLatencyMs.p95 > THRESHOLDS.fixtureLatencyP95MaxMs) failures.push(`fixtureLatencyP95:${aggregates.fixtureLatencyMs.p95}`);
  return failures;
}

/**
 * How much of the product-level CORE_AI_BENCHMARK this deterministic harness can honestly evidence.
 * It supplies automated-test evidence for two dimensions only; the scorecard therefore stays INCOMPLETE and
 * is reported as such (never rounded up to a pass).
 */
export function coreBenchmarkCoverage(aggregates: Aggregates) {
  const observations: EvaluationObservation[] = [
    { dimension: "retrieval_grounding", score: (aggregates.retrievalHitRate ?? 0) * 100, evidenceIds: ["contract-eval:retrieval"], evidenceKinds: ["automated_test"] },
    { dimension: "safety_policy_adherence", score: aggregates.policyViolations === 0 && aggregates.crossWorkspaceLeaks === 0 ? 100 : 0, evidenceIds: ["contract-eval:policy"], evidenceKinds: ["automated_test"] },
  ];
  const card = scoreEvaluation(CORE_AI_BENCHMARK, observations);
  return {
    complete: card.complete,
    pass: card.pass,
    dimensionsWithContractEvidence: observations.map(observation => observation.dimension),
    dimensionsWithoutEvidence: CORE_AI_BENCHMARK.map(spec => spec.id).filter(id => !observations.some(observation => observation.dimension === id)),
    note: "Contract-harness evidence only; the competitive scorecard is intentionally incomplete until real-model, human-review and source-audit evidence exists.",
  };
}

export type EvalReport = ReturnType<typeof buildReport>;

export function buildReport(results: readonly CaseResult[], meta: { commit?: string; generatedAt?: string } = {}) {
  const aggregates = aggregate(results);
  const failures = evaluateThresholds(results, aggregates);
  return {
    schema: EVAL_REPORT_SCHEMA,
    evidenceClass: EVIDENCE_CLASS,
    realModelQuality: "NOT_MEASURED" as const,
    paidProviderCalls: 0,
    commit: meta.commit ?? "unknown",
    generatedAt: meta.generatedAt ?? new Date().toISOString(),
    thresholds: { ...THRESHOLDS, passed: failures.length === 0, failures },
    aggregates,
    coreBenchmarkCoverage: coreBenchmarkCoverage(aggregates),
    cases: results,
  };
}
