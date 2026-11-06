import type { BrainExecutionState, BrainPlan, PlanStep } from "./types";

function cloneApprovals(approvals: ReadonlySet<string>): Set<string> {
  return new Set(approvals);
}

export function initializeExecution(plan: BrainPlan): BrainExecutionState {
  return {
    taskId: plan.taskId,
    toolCallsUsed: 0,
    approvals: new Set<string>(),
    steps: Object.fromEntries(
      plan.steps.map(step => [
        step.id,
        { stepId: step.id, status: "pending" as const, attempts: 0 },
      ]),
    ),
  };
}

function dependenciesSucceeded(step: PlanStep, state: BrainExecutionState): boolean {
  return step.dependsOn.every(dependency => state.steps[dependency]?.status === "succeeded");
}

export function getReadySteps(plan: BrainPlan, state: BrainExecutionState): PlanStep[] {
  return plan.steps.filter(step => {
    const runtime = state.steps[step.id];
    if (!runtime || runtime.status !== "pending") return false;
    if (!dependenciesSucceeded(step, state)) return false;
    if (step.requiresApproval && !state.approvals.has(step.id)) return false;
    if (step.kind === "tool" && state.toolCallsUsed >= plan.limits.maxToolCalls) return false;
    return true;
  });
}

export function grantStepApproval(state: BrainExecutionState, stepId: string): BrainExecutionState {
  const approvals = cloneApprovals(state.approvals);
  approvals.add(stepId);
  return { ...state, approvals };
}

export function startStep(plan: BrainPlan, state: BrainExecutionState, stepId: string): BrainExecutionState {
  const step = getReadySteps(plan, state).find(candidate => candidate.id === stepId);
  if (!step) throw new Error(`Step ${stepId} is not ready`);

  const runtime = state.steps[stepId];
  if (runtime.attempts >= Math.min(step.maxAttempts, plan.limits.maxRetriesPerStep + 1)) {
    throw new Error(`Step ${stepId} exceeded its attempt limit`);
  }

  return {
    ...state,
    toolCallsUsed: state.toolCallsUsed + (step.kind === "tool" ? 1 : 0),
    steps: {
      ...state.steps,
      [stepId]: {
        ...runtime,
        status: "running",
        attempts: runtime.attempts + 1,
        lastError: undefined,
      },
    },
  };
}

export function completeStep(state: BrainExecutionState, stepId: string): BrainExecutionState {
  const runtime = state.steps[stepId];
  if (!runtime || runtime.status !== "running") throw new Error(`Step ${stepId} is not running`);
  return {
    ...state,
    steps: {
      ...state.steps,
      [stepId]: { ...runtime, status: "succeeded", lastError: undefined },
    },
  };
}

export function failStep(plan: BrainPlan, state: BrainExecutionState, stepId: string, error: string): BrainExecutionState {
  const runtime = state.steps[stepId];
  const step = plan.steps.find(candidate => candidate.id === stepId);
  if (!runtime || !step || runtime.status !== "running") throw new Error(`Step ${stepId} is not running`);

  const attemptLimit = Math.min(step.maxAttempts, plan.limits.maxRetriesPerStep + 1);
  const terminal = runtime.attempts >= attemptLimit;
  return {
    ...state,
    steps: {
      ...state.steps,
      [stepId]: {
        ...runtime,
        status: terminal ? "failed" : "pending",
        lastError: error,
      },
    },
  };
}

export function executionSucceeded(plan: BrainPlan, state: BrainExecutionState): boolean {
  return plan.steps.every(step => state.steps[step.id]?.status === "succeeded" || state.steps[step.id]?.status === "skipped");
}

export function executionFailed(state: BrainExecutionState): boolean {
  return Object.values(state.steps).some(step => step.status === "failed");
}
