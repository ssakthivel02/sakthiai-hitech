export const SKILL_KINDS = ["retrieval", "analysis", "code", "browser", "connector", "filesystem", "deployment", "communication"] as const;
export type SkillKind = (typeof SKILL_KINDS)[number];

export type SideEffectLevel = "none" | "local_write" | "external_write" | "privileged";
export type SkillRisk = "low" | "medium" | "high" | "critical";

export interface SkillProfile {
  id: string;
  label: string;
  kind: SkillKind;
  description: string;
  sideEffect: SideEffectLevel;
  risk: SkillRisk;
  enabled: boolean;
  requiresNetwork: boolean;
  requiresCredential: boolean;
  requiresHumanApproval: boolean;
  meteredSpendPossible: boolean;
  tenantScoped: boolean;
}

export interface SkillExecutionRequest {
  skillId: string;
  humanApproved?: boolean;
  allowNetwork?: boolean;
  allowExternalWrites?: boolean;
  allowPrivilegedActions?: boolean;
  allowMeteredSpend?: boolean;
}

export interface SkillPolicyDecision {
  allowed: boolean;
  reasons: string[];
}
