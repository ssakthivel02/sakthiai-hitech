import { createHash } from "node:crypto";
import type { BrainExecutionState, BrainPlan, StepRuntimeState } from "./types";

export interface SerializableBrainExecutionState {
  taskId: string;
  steps: Record<string, StepRuntimeState>;
  approvals: string[];
  toolCallsUsed: number;
}

export interface ExecutionCheckpoint {
  version: 1;
  taskId: string;
  planFingerprint: string;
  state: SerializableBrainExecutionState;
  resumeEventId?: string;
  savedAt: string;
}

export interface ExecutionEvent {
  taskId: string;
  stepId?: string;
  type: "checkpoint" | "approval" | "step_started" | "step_completed" | "step_failed" | "reconciled";
  idempotencyKey?: string;
  occurredAt: string;
}

/**
 * Persistence contract only. Implementations must use a durable backing store
 * before SakthiAI may claim crash-safe/resumable agent execution.
 */
export interface DurableExecutionStore {
  loadCheckpoint(taskId: string): Promise<ExecutionCheckpoint | null>;
  saveCheckpoint(checkpoint: ExecutionCheckpoint): Promise<void>;
  claimIdempotencyKey(key: string): Promise<"claimed" | "duplicate">;
  appendEvent(event: ExecutionEvent): Promise<string>;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function fingerprintPlan(plan: BrainPlan): string {
  return hash(JSON.stringify({
    taskId: plan.taskId,
    limits: plan.limits,
    steps: plan.steps.map(step => ({
      id: step.id,
      kind: step.kind,
      role: step.role,
      dependsOn: step.dependsOn,
      requiresApproval: step.requiresApproval,
      maxAttempts: step.maxAttempts,
    })),
  }));
}

/** Stable key for exactly-once reconciliation of one plan step intent. */
export function stepIdempotencyKey(plan: BrainPlan, stepId: string): string {
  const step = plan.steps.find(candidate => candidate.id === stepId);
  if (!step) throw new Error(`Unknown plan step: ${stepId}`);
  return hash(`${plan.taskId}:${stepId}:${fingerprintPlan(plan)}`);
}

export function createExecutionCheckpoint(
  plan: BrainPlan,
  state: BrainExecutionState,
  options: { resumeEventId?: string; savedAt?: Date } = {},
): ExecutionCheckpoint {
  if (state.taskId !== plan.taskId) throw new Error("Execution state task does not match plan task");

  return {
    version: 1,
    taskId: plan.taskId,
    planFingerprint: fingerprintPlan(plan),
    state: {
      taskId: state.taskId,
      steps: Object.fromEntries(Object.entries(state.steps).map(([id, runtime]) => [id, { ...runtime }])),
      approvals: Array.from(state.approvals).sort(),
      toolCallsUsed: state.toolCallsUsed,
    },
    resumeEventId: options.resumeEventId,
    savedAt: (options.savedAt ?? new Date()).toISOString(),
  };
}

/**
 * Restoring a checkpoint never assumes an in-flight step finished safely.
 * A step that was `running` when the process stopped is restored as `blocked`
 * until its idempotency receipt/external effect is reconciled by the runtime.
 */
export function restoreExecutionCheckpoint(plan: BrainPlan, checkpoint: ExecutionCheckpoint): BrainExecutionState {
  if (checkpoint.version !== 1) throw new Error(`Unsupported checkpoint version: ${checkpoint.version}`);
  if (checkpoint.taskId !== plan.taskId || checkpoint.state.taskId !== plan.taskId) {
    throw new Error("Checkpoint task does not match plan task");
  }
  if (checkpoint.planFingerprint !== fingerprintPlan(plan)) {
    throw new Error("Checkpoint plan fingerprint does not match current plan");
  }

  const steps = Object.fromEntries(
    Object.entries(checkpoint.state.steps).map(([id, runtime]) => [
      id,
      runtime.status === "running"
        ? { ...runtime, status: "blocked" as const, lastError: "RESUME_REQUIRES_IDEMPOTENCY_RECONCILIATION" }
        : { ...runtime },
    ]),
  );

  return {
    taskId: checkpoint.state.taskId,
    steps,
    approvals: new Set(checkpoint.state.approvals),
    toolCallsUsed: checkpoint.state.toolCallsUsed,
  };
}

export function makeResumeEventId(taskId: string, sequence: number): string {
  if (!Number.isInteger(sequence) || sequence < 0) throw new Error("sequence must be a non-negative integer");
  return `${taskId}:${sequence}`;
}
