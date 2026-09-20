import { describe, expect, it } from "vitest";
import { assertSameGenerationIntent, type CreatorGenerationIntent } from "./idempotency";

const base: CreatorGenerationIntent = {
  creatorProjectId: 11,
  shotId: 22,
  kind: "VIDEO",
  provider: "google-veo",
  model: "veo-3.1-fast-generate-preview",
  parametersJson: JSON.stringify({ prompt: "Murugan", durationSeconds: 8 }),
  sourceAssetIdsJson: JSON.stringify([41, 42]),
};

describe("Creator generation idempotency intent", () => {
  it("accepts an exact replay of the same logical generation", () => {
    expect(() => assertSameGenerationIntent(base, { ...base })).not.toThrow();
  });

  it.each([
    ["creatorProjectId", 12],
    ["shotId", 23],
    ["kind", "IMAGE"],
    ["provider", "google-gemini-image"],
    ["model", "another-model"],
    ["parametersJson", JSON.stringify({ prompt: "Different", durationSeconds: 8 })],
    ["sourceAssetIdsJson", JSON.stringify([99])],
  ] as const)("rejects idempotency-key reuse when %s changes", (field, value) => {
    expect(() => assertSameGenerationIntent(base, { ...base, [field]: value })).toThrow(
      "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST",
    );
  });
});
