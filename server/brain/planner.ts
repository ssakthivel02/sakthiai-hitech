import type { BrainPlan, BrainTaskRequest, PlanStep } from "./types";

function hasIntent(task: BrainTaskRequest, intent: BrainTaskRequest["intents"][number]): boolean {
  return task.intents.includes(intent);
}

export function buildBrainPlan(task: BrainTaskRequest): BrainPlan {
  const steps: PlanStep[] = [];
  let previousId: string | undefined;

  const addStep = (
    kind: PlanStep["kind"],
    role: PlanStep["role"],
    title: string,
    options?: { requiresApproval?: boolean; maxAttempts?: number; dependsOn?: string[] },
  ) => {
    const id = `step-${steps.length + 1}-${kind}`;
    const dependsOn = options?.dependsOn ?? (previousId ? [previousId] : []);
    steps.push({
      id,
      kind,
      role,
      title,
      dependsOn,
      requiresApproval: options?.requiresApproval ?? false,
      maxAttempts: options?.maxAttempts ?? 2,
    });
    previousId = id;
    return id;
  };

  if (task.needsWorkspaceContext) {
    addStep("context", "memory", "Assemble tenant-scoped workspace context and relevant memory", { maxAttempts: 1 });
  }

  if (task.needsFreshInformation || hasIntent(task, "research")) {
    addStep("research", "researcher", "Collect fresh sources and provenance before synthesis");
  }

  addStep("reason", "analyst", "Decompose objective, constraints and evidence into an executable solution path");

  if (hasIntent(task, "coding")) {
    addStep("code", "coder", "Implement the bounded code change and execute the applicable test plan");
  }

  if (task.needsTools || hasIntent(task, "browser_work") || hasIntent(task, "automation")) {
    const risky = task.risk === "high" || task.risk === "critical";
    if (risky) {
      addStep("approval", "planner", "Require explicit approval before the risky external action", {
        requiresApproval: true,
        maxAttempts: 1,
      });
    }
    addStep(
      "tool",
      hasIntent(task, "browser_work") ? "browser" : "analyst",
      "Execute the bounded tool/action step and retain non-secret evidence",
      { maxAttempts: task.autonomy === "bounded_autonomous" ? 2 : 1 },
    );
  }

  addStep("verify", "verifier", "Verify task result against evidence, tests, grounding and safety requirements", {
    maxAttempts: 1,
  });
  addStep("synthesize", "synthesizer", "Produce the final grounded result with evidence and unresolved limitations", {
    maxAttempts: 1,
  });

  return {
    taskId: task.id,
    steps,
    limits: {
      maxSteps: 12,
      maxToolCalls: task.autonomy === "bounded_autonomous" ? 8 : task.autonomy === "supervised" ? 4 : 2,
      maxRetriesPerStep: 2,
    },
  };
}
