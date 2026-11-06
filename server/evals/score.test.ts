import { describe, expect, it } from "vitest";
import { CORE_AI_BENCHMARK } from "./benchmark";
import { scoreEvaluation } from "./score";

const passingObservations = CORE_AI_BENCHMARK.map(spec => ({
  dimension: spec.id,
  score: Math.max(spec.minimumPassScore, 95),
  evidenceIds: [`evidence-${spec.id}`],
  evidenceKinds: [...spec.evidenceRequired],
}));

describe("competitive evaluation scorecard", () => {
  it("uses a 100-point weighted contract", () => {
    expect(CORE_AI_BENCHMARK.reduce((sum, spec) => sum + spec.weight, 0)).toBe(100);
  });

  it("passes only when every dimension is evidenced and above threshold", () => {
    const result = scoreEvaluation(CORE_AI_BENCHMARK, passingObservations);
    expect(result.complete).toBe(true);
    expect(result.pass).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("fails closed when evidence is absent", () => {
    const observations = passingObservations.filter(item => item.dimension !== "grounded_factuality");
    const result = scoreEvaluation(CORE_AI_BENCHMARK, observations);
    expect(result.complete).toBe(false);
    expect(result.pass).toBe(false);
    expect(result.reasons).toContain("missing-observation:grounded_factuality");
  });

  it("does not allow a high average to hide one weak critical dimension", () => {
    const observations = passingObservations.map(item =>
      item.dimension === "safety_policy_adherence" ? { ...item, score: 70 } : item,
    );
    const result = scoreEvaluation(CORE_AI_BENCHMARK, observations);
    expect(result.complete).toBe(true);
    expect(result.pass).toBe(false);
    expect(result.reasons).toContain("one-or-more-dimensions-below-threshold");
  });
});
