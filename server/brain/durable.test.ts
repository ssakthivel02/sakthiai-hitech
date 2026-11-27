import { describe, expect, it } from "vitest";
import { completeStep, initializeExecution, startStep } from "./orchestrator";
import type { BrainPlan } from "./types";
import {
  createExecutionCheckpoint,
  fingerprintPlan,
  makeResumeEventId,
  restoreExecutionCheckpoint,
  stepIdempotencyKey,
} from "./durable";

const plan: BrainPlan = {
  taskId: "task-001",
  limits: { maxSteps: 4, maxToolCalls: 2, maxRetriesPerStep: 1 },
  steps: [
    {
      id: "read",
      kind: "context",
      role: "researcher",
      title: "Read context",
      dependsOn: [],
      requiresApproval: false,
      maxAttempts: 1,
    },
    {
      id: "act",
      kind: "tool",
      role: "browser",
      title: "Perform bounded action",
      dependsOn: ["read"],
      requiresApproval: false,
      maxAttempts: 2,
    },
  ],
};

describe("durable Brain execution contract", () => {
  it("creates deterministic plan fingerprints and step idempotency keys", () => {
    expect(fingerprintPlan(plan)).toBe(fingerprintPlan(plan));
    expect(stepIdempotencyKey(plan, "act")).toBe(stepIdempotencyKey(plan, "act"));
    expect(stepIdempotencyKey(plan, "act")).toHaveLength(64);
  });

  it("serializes approvals and restores completed state", () => {
    let state = initializeExecution(plan);
    state = startStep(plan, state, "read");
    state = completeStep(state, "read");
    const checkpoint = createExecutionCheckpoint(plan, state, { savedAt: new Date("2026-09-24T10:00:00Z") });
    const restored = restoreExecutionCheckpoint(plan, checkpoint);

    expect(restored.steps.read.status).toBe("succeeded");
    expect(restored.taskId).toBe(plan.taskId);
    expect(restored.toolCallsUsed).toBe(0);
  });

  it("fails closed when a checkpoint belongs to a different plan", () => {
    const checkpoint = createExecutionCheckpoint(plan, initializeExecution(plan));
    const changedPlan: BrainPlan = {
      ...plan,
      steps: plan.steps.map(step => step.id === "act" ? { ...step, maxAttempts: 1 } : step),
    };

    expect(() => restoreExecutionCheckpoint(changedPlan, checkpoint)).toThrow(/fingerprint/i);
  });

  it("blocks an in-flight step on resume until idempotency is reconciled", () => {
    let state = initializeExecution(plan);
    state = startStep(plan, state, "read");
    state = completeStep(state, "read");
    state = startStep(plan, state, "act");
    const checkpoint = createExecutionCheckpoint(plan, state);
    const restored = restoreExecutionCheckpoint(plan, checkpoint);

    expect(restored.steps.act.status).toBe("blocked");
    expect(restored.steps.act.lastError).toBe("RESUME_REQUIRES_IDEMPOTENCY_RECONCILIATION");
    expect(restored.toolCallsUsed).toBe(1);
  });

  it("provides stable resumable event cursor IDs", () => {
    expect(makeResumeEventId("task-001", 17)).toBe("task-001:17");
    expect(() => makeResumeEventId("task-001", -1)).toThrow(/non-negative/i);
  });
});
