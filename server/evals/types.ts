export const EVALUATION_DIMENSIONS = [
  "reasoning_task_success",
  "grounded_factuality",
  "research_source_quality",
  "coding_test_pass_rate",
  "tool_action_success",
  "agent_completion_rate",
  "retrieval_grounding",
  "long_context_reliability",
  "multilingual_quality",
  "multimodal_understanding",
  "latency_efficiency",
  "resource_efficiency",
  "safety_policy_adherence",
  "human_acceptance",
] as const;

export type EvaluationDimension = (typeof EVALUATION_DIMENSIONS)[number];

export interface EvaluationDimensionSpec {
  id: EvaluationDimension;
  weight: number;
  minimumPassScore: number;
  evidenceRequired: readonly ("automated_test" | "source_audit" | "tool_trace" | "human_review" | "resource_metric")[];
}

export interface EvaluationObservation {
  dimension: EvaluationDimension;
  score: number;
  evidenceIds: string[];
  evidenceKinds: string[];
}

export interface EvaluationScorecard {
  score: number;
  pass: boolean;
  complete: boolean;
  reasons: string[];
  perDimension: Array<{ dimension: EvaluationDimension; score: number; weightedContribution: number; pass: boolean }>;
}
