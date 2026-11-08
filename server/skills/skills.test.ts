import { describe, expect, it } from "vitest";
import { evaluateSkillPolicy } from "./policy";
import { getSkillProfile } from "./registry";

describe("SakthiAI skill policy", () => {
  it("allows enabled zero-side-effect local retrieval", () => {
    const skill = getSkillProfile("retrieval.read")!;
    expect(evaluateSkillPolicy(skill, { skillId: skill.id })).toEqual({ allowed: true, reasons: [] });
  });

  it("fails closed for disabled browser actions", () => {
    const skill = getSkillProfile("browser.action")!;
    const decision = evaluateSkillPolicy(skill, { skillId: skill.id });
    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toEqual(expect.arrayContaining([
      "skill-disabled",
      "network-not-approved",
      "human-approval-required",
      "external-write-not-approved",
    ]));
  });

  it("requires every privileged release gate including spend approval", () => {
    const skill = { ...getSkillProfile("deployment.release")!, enabled: true };
    const blocked = evaluateSkillPolicy(skill, {
      skillId: skill.id,
      allowNetwork: true,
      humanApproved: true,
      allowPrivilegedActions: true,
    });
    expect(blocked.allowed).toBe(false);
    expect(blocked.reasons).toContain("metered-spend-not-approved");

    const allowed = evaluateSkillPolicy(skill, {
      skillId: skill.id,
      allowNetwork: true,
      humanApproved: true,
      allowPrivilegedActions: true,
      allowMeteredSpend: true,
    });
    expect(allowed.allowed).toBe(true);
  });
});
