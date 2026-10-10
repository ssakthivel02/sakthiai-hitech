import { describe, expect, it } from "vitest";
import { EVAL_DIMENSIONS, THRESHOLDS, aggregate, buildReport, evaluateThresholds, type CaseResult, type StepMetrics } from "./metrics";

const step = (over: Partial<StepMetrics> = {}): StepMetrics => ({ retrievalExpected: true, retrievalMissExpected: false, retrievalHit: true, citationCount: 1, consistentCitations: 1, groundingExpected: "GROUNDED_EVIDENCE", groundingActual: "GROUNDED_EVIDENCE", groundingCorrect: true, providerSelected: "local", fallbackCount: 0, policyViolations: 0, timeoutExpected: false, timeoutClassified: null, reportedTokens: null, budgetDecision: "not_applicable", crossWorkspaceLeaks: 0, fixtureLatencyMs: 5, ...over });
const baseline = (): CaseResult[] =>
  Array.from({ length: THRESHOLDS.minCases }, (_, index) => ({ id: `c${index}`, dimension: EVAL_DIMENSIONS[index % EVAL_DIMENSIONS.length], description: "d", passed: true, failures: [], steps: [step({ timeoutExpected: index % 5 === 0, timeoutClassified: index % 5 === 0 ? true : null })] }));
const failuresOf = (results: CaseResult[]) => evaluateThresholds(results, aggregate(results));

describe("eval thresholds are sensitive to each regression class", () => {
  it("baseline passes", () => expect(failuresOf(baseline())).toEqual([]));
  const mutate = (fn: (steps: StepMetrics[], results: CaseResult[]) => void) => { const results = baseline(); fn(results.map(r => r.steps[0]), results); return failuresOf(results); };
  it("retrieval miss", () => expect(mutate(s => { s[1].retrievalHit = false; }).join()).toContain("retrievalHitRate"));
  it("unexpected retrieval hit on a no-evidence case", () => expect(mutate(s => { s[1].retrievalExpected = false; s[1].retrievalMissExpected = true; s[1].retrievalHit = true; }).join()).toContain("unexpectedRetrievalHits"));
  it("inconsistent citation", () => expect(mutate(s => { s[2].consistentCitations = 0; }).join()).toContain("citationCoverage"));
  it("wrong grounding state", () => expect(mutate(s => { s[3].groundingCorrect = false; }).join()).toContain("groundingStateAccuracy"));
  it("policy violation", () => expect(mutate(s => { s[4].policyViolations = 1; }).join()).toContain("policyViolations"));
  it("cross-workspace leak", () => expect(mutate(s => { s[5].crossWorkspaceLeaks = 1; }).join()).toContain("crossWorkspaceLeaks"));
  it("unclassified timeout", () => expect(mutate(s => { s[0].timeoutClassified = false; }).join()).toContain("timeoutClassificationRate"));
  it("latency blow-up", () => expect(mutate(s => s.forEach(x => { x.fixtureLatencyMs = 9999; })).join()).toContain("fixtureLatencyP95"));
  it("failed case", () => expect(mutate((_s, r) => { r[6].passed = false; r[6].failures = ["boom"]; }).join()).toContain("case-failed:c6"));
  it("too few cases / uncovered dimension", () => {
    const results = baseline().slice(0, 5);
    const out = failuresOf(results).join();
    expect(out).toContain("cases:5");
    expect(out).toContain("dimension-uncovered");
  });
  it("empty run is a failure, never a vacuous pass", () => expect(failuresOf([]).length).toBeGreaterThan(0));
});

describe("report honesty", () => {
  it("labels itself contract-harness, reports no real-model quality or paid calls, and keeps the scorecard incomplete", () => {
    const report = buildReport(baseline());
    expect(report).toMatchObject({ evidenceClass: "CONTRACT_HARNESS", realModelQuality: "NOT_MEASURED", paidProviderCalls: 0 });
    expect(report.coreBenchmarkCoverage.complete).toBe(false);
    expect(report.coreBenchmarkCoverage.dimensionsWithoutEvidence.length).toBeGreaterThan(0);
  });
  it("never invents cost: only provider-reported tokens are aggregated", () => {
    const results = baseline();
    results[0].steps[0].reportedTokens = 48;
    const report = buildReport(results);
    expect(report.aggregates.reportedTokenTotal).toBe(48);
    expect(JSON.stringify(report)).not.toMatch(/"cost"/);
  });
});
