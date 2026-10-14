import { describe, expect, it } from "vitest";
import { CREATOR_MAX_VIDEO_SECONDS, estimateCreatorCost, isAuthorizedForPaidKind, paidKindOf, readCreatorPaidConfig } from "./paidPolicy";

const env = {
  CREATOR_PAID_GENERATION_ENABLED: "true",
  CREATOR_PAID_IMAGE_USERS: " a , ,b ",
  CREATOR_PAID_VIDEO_USERS: "",
  CREATOR_MODEL_COSTS: JSON.stringify({ img: { perGeneration: 0.039 }, vid: { perSecond: 0.1 }, both: { perGeneration: 1, perSecond: 0.5 } }),
  CREATOR_GLOBAL_MAX_GENERATIONS_PER_DAY: "10",
  CREATOR_GLOBAL_MAX_COST_PER_DAY: "5.5",
  CREATOR_WORKSPACE_MAX_GENERATIONS_PER_DAY: "5",
  CREATOR_WORKSPACE_MAX_COST_PER_DAY: "2",
  CREATOR_USER_MAX_GENERATIONS_PER_DAY: "3",
  CREATOR_USER_MAX_COST_PER_DAY: "1",
};

function config(overrides: Record<string, string | undefined> = {}) {
  const result = readCreatorPaidConfig({ ...env, ...overrides });
  if (!result.ok) throw new Error(result.code);
  return result.config;
}

describe("Creator paid policy", () => {
  it("parses allowlists exactly (trimmed, empties dropped) and limits", () => {
    const c = config();
    expect([...c.imageUsers]).toEqual(["a", "b"]);
    expect(c.videoUsers.size).toBe(0);
    expect(c.limits).toEqual({ globalGenerations: 10, globalCost: 5.5, workspaceGenerations: 5, workspaceCost: 2, userGenerations: 3, userCost: 1 });
  });

  it("generation limits must be integers; cost limits may be decimal", () => {
    expect(readCreatorPaidConfig({ ...env, CREATOR_USER_MAX_GENERATIONS_PER_DAY: "2.5" })).toMatchObject({ ok: false, code: "CREATOR_SPEND_POLICY_INVALID" });
    expect(readCreatorPaidConfig({ ...env, CREATOR_USER_MAX_COST_PER_DAY: "0.25" }).ok).toBe(true);
  });

  it.each([
    [JSON.stringify([])],
    [JSON.stringify({})],
    [JSON.stringify({ m: {} })],
    [JSON.stringify({ m: { perGeneration: -1 } })],
    [JSON.stringify({ m: { perGeneration: "1" } })],
    [JSON.stringify({ m: { perGeneration: 1, perToken: 2 } })],
  ])("rejects cost table %s", costs => {
    expect(readCreatorPaidConfig({ ...env, CREATOR_MODEL_COSTS: costs })).toMatchObject({ ok: false, code: "CREATOR_SPEND_POLICY_INVALID" });
  });

  it("costs: per generation, per second × duration, missing duration charged at the maximum, rounded up to 6 dp", () => {
    const c = config();
    expect(estimateCreatorCost(c, "img", { kind: "IMAGE", prompt: "p" })).toBe(0.039);
    expect(estimateCreatorCost(c, "vid", { kind: "VIDEO", prompt: "p", durationSeconds: 6 })).toBe(0.6);
    expect(estimateCreatorCost(c, "vid", { kind: "VIDEO", prompt: "p" })).toBe(0.1 * CREATOR_MAX_VIDEO_SECONDS);
    expect(estimateCreatorCost(c, "both", { kind: "VIDEO", prompt: "p", durationSeconds: 4 })).toBe(3);
    expect(estimateCreatorCost(c, "unknown", { kind: "IMAGE", prompt: "p" })).toBeUndefined();
    expect(estimateCreatorCost(config({ CREATOR_MODEL_COSTS: JSON.stringify({ x: { perGeneration: 0.0000001 } }) }), "x", { kind: "IMAGE", prompt: "p" })).toBe(0.000001);
  });

  it("maps kinds: edits are images, extensions and unknown kinds are videos (most expensive class)", () => {
    expect(paidKindOf("IMAGE_EDIT")).toBe("IMAGE");
    expect(paidKindOf("VIDEO_EXTENSION")).toBe("VIDEO");
    expect(paidKindOf("SOMETHING_NEW")).toBe("VIDEO");
  });

  it("authorization: admin for both kinds; others only via the matching allowlist; no openId = denied", () => {
    const c = config();
    expect(isAuthorizedForPaidKind({ role: "admin" }, "VIDEO", c)).toBe(true);
    expect(isAuthorizedForPaidKind({ role: "user", openId: "a" }, "IMAGE", c)).toBe(true);
    expect(isAuthorizedForPaidKind({ role: "user", openId: "a" }, "VIDEO", c)).toBe(false);
    expect(isAuthorizedForPaidKind({ role: "user", openId: null }, "IMAGE", c)).toBe(false);
  });
});
