import type { SkillExecutionRequest, SkillPolicyDecision, SkillProfile } from "./types";

export function evaluateSkillPolicy(skill: SkillProfile, request: SkillExecutionRequest): SkillPolicyDecision {
  const reasons: string[] = [];

  if (!skill.enabled) reasons.push("skill-disabled");
  if (skill.requiresNetwork && request.allowNetwork !== true) reasons.push("network-not-approved");
  if (skill.requiresHumanApproval && request.humanApproved !== true) reasons.push("human-approval-required");
  if (skill.sideEffect === "external_write" && request.allowExternalWrites !== true) reasons.push("external-write-not-approved");
  if (skill.sideEffect === "privileged" && request.allowPrivilegedActions !== true) reasons.push("privileged-action-not-approved");
  if (skill.meteredSpendPossible && request.allowMeteredSpend !== true) reasons.push("metered-spend-not-approved");

  return { allowed: reasons.length === 0, reasons };
}
