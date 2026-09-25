import type { ModelCapability, TaskIntent } from "../model-fabric/types";

export const AGENT_ROLES = [
  "planner",
  "researcher",
  "coder",
  "analyst",
  "browser",
  "memory",
  "multimodal",
  "verifier",
  "synthesizer",
] as const;

export type AgentRole = (typeof AGENT_ROLES)[number];
export type RiskLevel = "low" | "medium" | "high" | "critical";
export type AutonomyMode = "assist" | "supervised" | "bounded_autonomous";
export type PlanStepKind = "context" | "research" | "reason" | "code" | "tool" | "approval" | "verify" | "synthesize";
export type StepStatus = "pending" | "ready" | "running" | "blocked" | "succeeded" | "failed" | "skipped";
export type EvidenceKind = "source" | "retrieval" | "test" | "tool_result" | "approval" | "checksum" | "human_review";

export interface BrainTaskRequest {
  id: string;
  objective: string;
  intents: readonly TaskIntent[];
  requiredCapabilities?: readonly ModelCapability[];
  needsFreshInformation?: boolean;
  needsWorkspaceContext?: boolean;
  needsTools?: boolean;
  risk: RiskLevel;
  autonomy: AutonomyMode;
}

export interface PlanStep {
  id: string;
  kind: PlanStepKind;
  role: AgentRole;
  title: string;
  dependsOn: string[];
  requiresApproval: boolean;
  maxAttempts: number;
}

export interface BrainPlan {
  taskId: string;
  steps: PlanStep[];
  limits: {
    maxSteps: number;
    maxToolCalls: number;
    maxRetriesPerStep: number;
  };
}

export interface StepRuntimeState {
  stepId: string;
  status: StepStatus;
  attempts: number;
  lastError?: string;
}

export interface BrainExecutionState {
  taskId: string;
  steps: Record<string, StepRuntimeState>;
  approvals: ReadonlySet<string>;
  toolCallsUsed: number;
}

export interface EvidenceArtifact {
  id: string;
  kind: EvidenceKind;
  stepId?: string;
  label: string;
  trusted: boolean;
}

export interface VerificationPolicy {
  requiredEvidence: readonly EvidenceKind[];
  minimumTrustedSources?: number;
  requireTestsForCoding?: boolean;
  requireHumanApprovalForRisk?: RiskLevel;
}

export interface VerificationResult {
  pass: boolean;
  reasons: string[];
  evidenceUsed: string[];
}
