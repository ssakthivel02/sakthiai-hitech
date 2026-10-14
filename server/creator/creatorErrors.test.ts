import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { describeCreatorError } from "@shared/creatorErrors";

const GENERIC = new Set(["Creator request refused", "Creator operation failed"]);

describe("describeCreatorError", () => {
  it("has a dedicated explanation for every code the paid-generation path can return", () => {
    const sources = ["server/creator/paidGeneration.ts", "server/creator/router.ts", "server/creator/orchestrator.ts", "server/creator/spendAdmin.ts"].map(f => readFileSync(f, "utf8")).join("\n");
    const codes = new Set([...sources.matchAll(/message: [`"](CREATOR_[A-Z_]+)/g)].map(m => m[1]));
    for (const required of ["CREATOR_PAID_GENERATION_DISABLED", "CREATOR_PAID_GENERATION_NOT_AUTHORIZED", "CREATOR_WORKSPACE_OWNER_REQUIRED", "CREATOR_SPEND_POLICY_INVALID", "CREATOR_MODEL_NOT_PRICED", "CREATOR_BUDGET_EXHAUSTED", "CREATOR_SPEND_LEDGER_UNAVAILABLE", "CREATOR_RUNTIME_ACCEPTANCE_BLOCKED", "CREATOR_PROVIDER_REQUEST_FAILED"]) expect(codes).toContain(required);
    for (const code of codes) expect(GENERIC.has(describeCreatorError(`${code}:x`).title), code).toBe(false);
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
