import { describe, expect, it } from "vitest";
import { generationStateAfterProviderState } from "./lifecycle";

describe("Creator provider versus durable generation lifecycle", () => {
  it("keeps a provider success non-terminal until SakthiAI persists the artifact", () => {
    expect(generationStateAfterProviderState("SUCCEEDED")).toBe("RUNNING");
  });

  it("preserves retryable and terminal provider failures", () => {
    expect(generationStateAfterProviderState("RETRYABLE")).toBe("RETRYABLE");
    expect(generationStateAfterProviderState("FAILED")).toBe("FAILED");
    expect(generationStateAfterProviderState("CANCELLED")).toBe("CANCELLED");
  });
});
