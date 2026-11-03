import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { describeCreatorError } from "@shared/creatorErrors";

const GENERIC = new Set(["Creator request refused", "Creator operation failed"]);

describe("describeCreatorError", () => {
  it("has a dedicated explanation for every code the paid-generation path can return", () => {
    const sources = ["server/creator/paidGeneration.ts", "server/creator/router.ts", "server/creator/orchestrator.ts", "server/creator/spendAdmin.ts", "server/creator/routerGuards.ts", "server/creator/speechAvatarRouter.ts"].map(f => readFileSync(f, "utf8")).join("\n");
    const codes = new Set([...sources.matchAll(/message: [`"](CREATOR_[A-Z_]+)/g)].map(m => m[1]));
    for (const required of ["CREATOR_PAID_GENERATION_DISABLED", "CREATOR_PAID_GENERATION_NOT_AUTHORIZED", "CREATOR_WORKSPACE_OWNER_REQUIRED", "CREATOR_SPEND_POLICY_INVALID", "CREATOR_MODEL_NOT_PRICED", "CREATOR_BUDGET_EXHAUSTED", "CREATOR_SPEND_LEDGER_UNAVAILABLE", "CREATOR_RUNTIME_ACCEPTANCE_BLOCKED", "CREATOR_PROVIDER_REQUEST_FAILED"]) expect(codes).toContain(required);
    for (const code of codes) expect(GENERIC.has(describeCreatorError(`${code}:x`).title), code).toBe(false);
  });

  it("explains every consent, avatar-audio and cancellation refusal of the speech/avatar path", () => {
    const sources = ["server/creator/speech/consentStore.ts", "server/creator/speech/audioAsset.ts", "server/creator/speech/speechReview.ts", "server/creator/derivativeReview.ts", "server/creator/renderService.ts", "server/creator/jobControl.ts"].map(f => readFileSync(f, "utf8")).join("\n");
    const codes = [...new Set([...sources.matchAll(/new Error\("(CREATOR_(?:CONSENT|AVATAR_AUDIO|PROVIDER_CANCEL|SPEECH_REVIEW|DERIVATIVE)_[A-Z_]+)"\)/g)].map(m => m[1]))];
    expect(codes.length).toBeGreaterThan(8);
    for (const code of codes.filter(c => !["CREATOR_CONSENT_SUBJECT_INVALID", "CREATOR_CONSENT_VALID_UNTIL_PAST", "CREATOR_CONSENT_CREATE_FAILED", "CREATOR_CONSENT_NOT_FOUND_OR_REVOKED"].includes(c))) {
      expect(GENERIC.has(describeCreatorError(code).title), code).toBe(false);
    }
    expect(describeCreatorError("CREATOR_PAID_GENERATION_NOT_AUTHORIZED:AVATAR_VIDEO").title).toBe("Not approved for paid avatar video generation");
  });

  it("keeps the raw code (with its argument) for support and explains scope/kind", () => {
    expect(describeCreatorError("CREATOR_BUDGET_EXHAUSTED:workspace")).toMatchObject({ code: "CREATOR_BUDGET_EXHAUSTED:workspace", kind: "limit", detail: expect.stringContaining("this workspace's") });
    expect(describeCreatorError("CREATOR_PAID_GENERATION_NOT_AUTHORIZED:VIDEO").title).toMatch(/video/);
    expect(describeCreatorError("CREATOR_MODEL_NOT_PRICED:veo-x").detail).toContain("veo-x");
  });

  it("states that nothing was charged where that is guaranteed by the server", () => {
    for (const code of ["CREATOR_PAID_GENERATION_DISABLED", "CREATOR_BUDGET_EXHAUSTED:global", "CREATOR_MODEL_NOT_PRICED:m"]) expect(describeCreatorError(code).detail).toMatch(/nothing was (submitted|charged)|no request was sent/i);
  });

  it("falls back safely for unknown, empty and rate-limit messages", () => {
    expect(describeCreatorError("")).toMatchObject({ code: "UNKNOWN", kind: "error" });
    expect(describeCreatorError(undefined).title).toBe("Creator operation failed");
    expect(describeCreatorError("Rate limit exceeded. Retry in 20 seconds.")).toMatchObject({ code: "TOO_MANY_REQUESTS", kind: "limit" });
  });
});
