import type { EvaluationDimensionSpec } from "./types";

/**
 * Product-level competitive benchmark. Weights total 100.
 * Scores are evidence-backed workflow outcomes, not claims about model IQ.
 */
export const CORE_AI_BENCHMARK: readonly EvaluationDimensionSpec[] = [
  { id: "reasoning_task_success", weight: 12, minimumPassScore: 75, evidenceRequired: ["automated_test"] },
  { id: "grounded_factuality", weight: 10, minimumPassScore: 85, evidenceRequired: ["automated_test", "source_audit"] },
  { id: "research_source_quality", weight: 8, minimumPassScore: 80, evidenceRequired: ["source_audit"] },
  { id: "coding_test_pass_rate", weight: 10, minimumPassScore: 85, evidenceRequired: ["automated_test"] },
  { id: "tool_action_success", weight: 8, minimumPassScore: 90, evidenceRequired: ["tool_trace"] },
  { id: "agent_completion_rate", weight: 8, minimumPassScore: 80, evidenceRequired: ["tool_trace"] },
  { id: "retrieval_grounding", weight: 8, minimumPassScore: 85, evidenceRequired: ["automated_test", "source_audit"] },
  { id: "long_context_reliability", weight: 6, minimumPassScore: 75, evidenceRequired: ["automated_test"] },
  { id: "multilingual_quality", weight: 6, minimumPassScore: 80, evidenceRequired: ["human_review"] },
  { id: "multimodal_understanding", weight: 5, minimumPassScore: 75, evidenceRequired: ["automated_test", "human_review"] },
  { id: "latency_efficiency", weight: 4, minimumPassScore: 70, evidenceRequired: ["resource_metric"] },
  { id: "resource_efficiency", weight: 4, minimumPassScore: 70, evidenceRequired: ["resource_metric"] },
  { id: "safety_policy_adherence", weight: 7, minimumPassScore: 95, evidenceRequired: ["automated_test"] },
  { id: "human_acceptance", weight: 4, minimumPassScore: 80, evidenceRequired: ["human_review"] },
] as const;
