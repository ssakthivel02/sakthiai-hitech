import { describe, expect, it, vi } from "vitest";
import { requireCreatorRemoteCancel, resolveCreatorRetryMode } from "./jobControl";
import type { CreatorMediaProvider } from "./types";

function provider(cancel?: CreatorMediaProvider["cancel"]): CreatorMediaProvider {
  return {
    id: "test-provider",
    status: () => ({ provider: "test-provider", configured: true, defaultModel: "test", capabilities: {} }),
    supports: () => true,
    submit: vi.fn(),
    poll: vi.fn(),
    cancel,
    classifyFailure: () => "UNKNOWN",
  };
}

describe("Creator retry policy", () => {
  it("recovers artifact persistence by reusing the completed provider job", () => {
    expect(
      resolveCreatorRetryMode({ generationState: "RETRYABLE", failureClass: "ARTIFACT", providerJobState: "SUCCEEDED" }),
    ).toBe("REPOLL_COMPLETED_JOB_FOR_ARTIFACT");
  });

  it("re-polls an existing retryable provider job without regenerating media", () => {
    expect(
      resolveCreatorRetryMode({ generationState: "RETRYABLE", failureClass: "NETWORK", providerJobState: "RETRYABLE" }),
    ).toBe("REPOLL_EXISTING_PROVIDER_JOB");
  });

  it("rejects retry when a new generation would be required", () => {
    expect(() =>
      resolveCreatorRetryMode({ generationState: "RETRYABLE", failureClass: "UNKNOWN", providerJobState: "FAILED" }),
    ).toThrow("CREATOR_RETRY_REQUIRES_NEW_GENERATION");
  });

  it("rejects retry for non-retryable generations", () => {
    expect(() => resolveCreatorRetryMode({ generationState: "FAILED", providerJobState: "FAILED" })).toThrow(
      "CREATOR_GENERATION_NOT_RETRYABLE",
    );
  });
});

describe("Creator cancellation policy", () => {
  it("refuses to claim cancellation when the provider has no remote cancel operation", () => {
    expect(() => requireCreatorRemoteCancel(provider())).toThrow("CREATOR_PROVIDER_CANCEL_UNSUPPORTED");
  });

  it("returns the real provider cancellation operation when supported", async () => {
    const cancel = vi.fn(async providerJobId => ({
      providerJobId,
      state: "CANCELLED" as const,
      raw: { acknowledged: true },
      artifacts: [],
    }));
    const remoteCancel = requireCreatorRemoteCancel(provider(cancel));
    await expect(remoteCancel("job-1")).resolves.toMatchObject({ state: "CANCELLED" });
    expect(cancel).toHaveBeenCalledWith("job-1");
  });
});
