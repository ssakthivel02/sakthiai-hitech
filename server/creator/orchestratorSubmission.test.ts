import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  beginProviderSubmission: vi.fn(),
  createQueuedGeneration: vi.fn(),
  getGenerationExecutionContext: vi.fn(),
  markGenerationFailed: vi.fn(),
  markGenerationSubmissionUnknown: vi.fn(),
  recordProviderPoll: vi.fn(),
  recordProviderSubmission: vi.fn(),
  providerSubmit: vi.fn(),
  classifyFailure: vi.fn(),
  selectCreatorProvider: vi.fn(),
}));

vi.mock("./persistence", () => ({
  beginProviderSubmission: mocks.beginProviderSubmission,
  createQueuedGeneration: mocks.createQueuedGeneration,
  getGenerationExecutionContext: mocks.getGenerationExecutionContext,
  markGenerationFailed: mocks.markGenerationFailed,
  markGenerationSubmissionUnknown: mocks.markGenerationSubmissionUnknown,
  recordProviderPoll: mocks.recordProviderPoll,
  recordProviderSubmission: mocks.recordProviderSubmission,
}));

vi.mock("./providerRegistry", () => ({
  getCreatorProvider: vi.fn(),
  selectCreatorProvider: mocks.selectCreatorProvider,
}));

vi.mock("./artifactPersistence", () => ({
  markCreatorArtifactRetryable: vi.fn(),
  persistCreatorGenerationArtifact: vi.fn(),
}));

vi.mock("./jobControl", () => ({
  requireCreatorRemoteCancel: vi.fn(),
  resolveCreatorRetryMode: vi.fn(),
}));

import { submitCreatorGeneration } from "./orchestrator";

const request = {
  kind: "VIDEO" as const,
  prompt: "Murugan cinematic shot",
  aspectRatio: "16:9" as const,
  resolution: "1080p" as const,
  durationSeconds: 8 as const,
};

const input = {
  workspaceId: 1,
  creatorProjectId: 2,
  shotId: 3,
  idempotencyKey: "123e4567-e89b-12d3-a456-426614174000",
  request,
};

describe("Creator paid submission spend control", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.beginProviderSubmission.mockResolvedValue(undefined);
    mocks.markGenerationFailed.mockResolvedValue(undefined);
    mocks.markGenerationSubmissionUnknown.mockResolvedValue(undefined);
    mocks.recordProviderSubmission.mockResolvedValue(undefined);
    mocks.classifyFailure.mockReturnValue("UNKNOWN");
    mocks.selectCreatorProvider.mockReturnValue({
      id: "google-veo",
      status: () => ({
        provider: "google-veo",
        configured: true,
        defaultModel: "veo-3.1-fast-generate-preview",
        capabilities: {},
      }),
      supports: () => true,
      submit: mocks.providerSubmit,
      poll: vi.fn(),
      classifyFailure: mocks.classifyFailure,
    });
  });

  it("does not submit again when the idempotency key already owns a generation", async () => {
    mocks.createQueuedGeneration.mockResolvedValue({ generationId: 7, created: false });
    mocks.getGenerationExecutionContext.mockResolvedValue({
      generation: {
        id: 7,
        provider: "google-veo",
        status: "SUBMITTED",
        outputAssetId: null,
        failureClass: null,
        errorMessage: null,
      },
      providerJob: { status: "SUBMITTED" },
    });

    const result = await submitCreatorGeneration(input);

    expect(result).toMatchObject({ generationId: 7, reused: true });
    expect(mocks.beginProviderSubmission).not.toHaveBeenCalled();
    expect(mocks.providerSubmit).not.toHaveBeenCalled();
  });

  it("marks submission intent before making the first paid provider call", async () => {
    mocks.createQueuedGeneration.mockResolvedValue({ generationId: 8, created: true });
    mocks.providerSubmit.mockResolvedValue({
      providerJobId: "job-8",
      state: "SUBMITTED",
      provider: "google-veo",
      model: "veo-3.1-fast-generate-preview",
      raw: {},
    });

    await submitCreatorGeneration(input);

    expect(mocks.beginProviderSubmission).toHaveBeenCalledWith({
      workspaceId: 1,
      creatorProjectId: 2,
      generationId: 8,
    });
    expect(mocks.beginProviderSubmission.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.providerSubmit.mock.invocationCallOrder[0],
    );
    expect(mocks.recordProviderSubmission).toHaveBeenCalledTimes(1);
  });

  it("leaves an accepted-but-unpersisted provider submission reconciliation-only", async () => {
    mocks.createQueuedGeneration.mockResolvedValue({ generationId: 9, created: true });
    mocks.providerSubmit.mockResolvedValue({
      providerJobId: "job-9",
      state: "SUBMITTED",
      provider: "google-veo",
      model: "veo-3.1-fast-generate-preview",
      raw: {},
    });
    mocks.recordProviderSubmission.mockRejectedValue(new Error("database write failed"));

    await expect(submitCreatorGeneration(input)).rejects.toThrow("database write failed");

    expect(mocks.markGenerationSubmissionUnknown).toHaveBeenCalledWith(
      expect.objectContaining({ generationId: 9, failureClass: "UNKNOWN" }),
    );
    expect(mocks.markGenerationFailed).not.toHaveBeenCalled();
    expect(mocks.providerSubmit).toHaveBeenCalledTimes(1);
  });
});
