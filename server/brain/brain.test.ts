import { describe, expect, it } from "vitest";
import { buildBrainPlan } from "./planner";
import {
  completeStep,
  executionFailed,
  failStep,
  getReadySteps,
  grantStepApproval,
  initializeExecution,
  startStep,
} from "./orchestrator";
import { verifyEvidence } from "./verifier";

const highRiskAutomation = buildBrainPlan({
  id: "task-risky",
  objective: "Apply an external infrastructure change",
  intents: ["automation"],
  requiredCapabilities: ["tool_use"],
  needsTools: true,
  risk: "high",
  autonomy: "supervised",
});

describe("SakthiAI brain foundation", () => {
  it("inserts an approval gate before high-risk tool execution", () => {
    const approval = highRiskAutomation.steps.find(step => step.kind === "approval");
    const tool = highRiskAutomation.steps.find(step => step.kind === "tool");

    expect(approval).toBeDefined();
    expect(tool?.dependsOn).toEqual([approval?.id]);

    let state = initializeExecution(highRiskAutomation);
    const reason = getReadySteps(highRiskAutomation, state)[0];
    expect(reason.kind).toBe("reason");

    state = completeStep(state = startStep(highRiskAutomation, state, reason.id), reason.id);
    expect(getReadySteps(highRiskAutomation, state)).toHaveLength(0);

    state = grantStepApproval(state, approval!.id);
    expect(getReadySteps(highRiskAutomation, state).map(step => step.kind)).toEqual(["approval"]);

    state = completeStep(state = startStep(highRiskAutomation, state, approval!.id), approval!.id);
    expect(getReadySteps(highRiskAutomation, state).map(step => step.kind)).toEqual(["tool"]);
  });

  it("does not add a human approval step for a low-risk assist task", () => {
    const plan = buildBrainPlan({
      id: "task-safe",
      objective: "Summarize a local document",
      intents: ["document_work"],
      needsWorkspaceContext: true,
      risk: "low",
      autonomy: "assist",
    });

    expect(plan.steps.some(step => step.kind === "approval")).toBe(false);
    expect(plan.steps.map(step => step.kind)).toEqual(["context", "reason", "verify", "synthesize"]);
  });

  it("bounds retries and converts repeated failure into terminal failure", () => {
    const plan = buildBrainPlan({
      id: "task-code",
      objective: "Implement a tested code change",
      intents: ["coding"],
      risk: "medium",
      autonomy: "supervised",
    });

    let state = initializeExecution(plan);
    const reason = getReadySteps(plan, state)[0];
    state = completeStep(state = startStep(plan, state, reason.id), reason.id);

    const code = getReadySteps(plan, state)[0];
    expect(code.kind).toBe("code");
    state = failStep(plan, startStep(plan, state, code.id), code.id, "test failure 1");
    expect(state.steps[code.id].status).toBe("pending");
    state = failStep(plan, startStep(plan, state, code.id), code.id, "test failure 2");
    expect(state.steps[code.id].status).toBe("failed");
    expect(executionFailed(state)).toBe(true);
  });

  it("fails verification when required evidence or risky approval is absent", () => {
    const result = verifyEvidence(
      {
        requiredEvidence: ["source"],
        minimumTrustedSources: 2,
        requireHumanApprovalForRisk: "high",
      },
      [{ id: "source-1", kind: "source", label: "One source", trusted: true }],
      "high",
    );

    expect(result.pass).toBe(false);
    expect(result.reasons).toEqual(
      expect.arrayContaining(["insufficient-trusted-sources:1/2", "approval-required-for-risk:high"]),
    );
  });

  it("passes evidence verification only when the declared gate is satisfied", () => {
    const result = verifyEvidence(
      {
        requiredEvidence: ["source", "test"],
        minimumTrustedSources: 1,
        requireTestsForCoding: true,
        requireHumanApprovalForRisk: "high",
      },
      [
        { id: "source-1", kind: "source", label: "Authoritative source", trusted: true },
        { id: "test-1", kind: "test", label: "Exact-head tests", trusted: true },
        { id: "approval-1", kind: "approval", label: "Owner approval", trusted: true },
      ],
      "critical",
    );

    expect(result.pass).toBe(true);
    expect(result.reasons).toEqual([]);
  });
});
