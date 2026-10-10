import { markCreatorArtifactRetryable, persistCreatorGenerationArtifact } from "./artifactPersistence";
import { requireCreatorRemoteCancel, resolveCreatorRetryMode } from "./jobControl";
import {
  beginProviderSubmission,
  createQueuedGeneration,
  getGenerationExecutionContext,
  markGenerationFailed,
  markGenerationSubmissionUnknown,
  recordProviderPoll,
  recordProviderSubmission,
} from "./persistence";
import { getCreatorProvider, selectCreatorProvider } from "./providerRegistry";
import { generationStateAfterProviderState } from "./lifecycle";
import type { CreatorPaidKind } from "./paidPolicy";
import { paidKindOf } from "./paidPolicy";
import type { CreatorFailureClass, CreatorJobState, CreatorMediaRequest } from "./types";

/**
 * Mandatory spend control for paid submission (no default: a caller cannot reach a provider without one).
 * - `price` runs before any row is written and throws when the resolved model has no server-side price.
 * - `reserve` runs only in the request that created the generation row (the only one that calls the provider),
 *   before the provider call; it throws to deny. Concurrent duplicates of the same idempotency key get `reused`
 *   and never reserve or settle, so a reservation can never be released while its provider call proceeds.
 * - Settlement methods never throw (an unsettled hold stays HELD = counted).
 */
export type CreatorSpendHook = {
  price(input: { kind: CreatorPaidKind; model: string; request: CreatorMediaRequest }): void;
  reserve(input: { kind: CreatorPaidKind; model: string; request: CreatorMediaRequest }): Promise<{ created: boolean }>;
  commit(generationId: number): Promise<void>;
  release(): Promise<void>;
  markUnknown(generationId: number): Promise<void>;
};

const RETRYABLE_FAILURES = new Set<CreatorFailureClass>([
  "QUOTA",
  "RATE_LIMIT",
  "PROVIDER_UNAVAILABLE",
  "TIMEOUT",
  "NETWORK",
  "ARTIFACT",
]);

const AMBIGUOUS_SUBMISSION_FAILURES = new Set<CreatorFailureClass>([
  "NETWORK",
  "TIMEOUT",
  "PROVIDER_UNAVAILABLE",
  "UNKNOWN",
]);

function sourceAssetIds(request: CreatorMediaRequest): number[] {
  const ids = [
    ...(request.references ?? []).map(reference => reference.assetId),
    request.kind === "VIDEO" || request.kind === "VIDEO_EXTENSION" ? request.firstFrame?.assetId : undefined,
    request.kind === "VIDEO" || request.kind === "VIDEO_EXTENSION" ? request.lastFrame?.assetId : undefined,
    request.kind === "VIDEO_EXTENSION" ? request.sourceVideoAssetId : undefined,
  ].filter((id): id is number => typeof id === "number");
  return [...new Set(ids)];
}

export function creatorRequestProvenance(request: CreatorMediaRequest) {
  const common = {
    kind: request.kind,
    prompt: request.prompt,
    model: request.model ?? null,
    aspectRatio: request.aspectRatio ?? null,
    referenceAssetIds: (request.references ?? []).map(reference => reference.assetId ?? null),
    referenceCount: request.references?.length ?? 0,
  };
  if (request.kind === "IMAGE" || request.kind === "IMAGE_EDIT") {
    return { ...common, imageSize: request.imageSize ?? null };
  }
  return {
    ...common,
    resolution: request.resolution ?? null,
    durationSeconds: request.durationSeconds ?? null,
    firstFrameAssetId: request.firstFrame?.assetId ?? null,
    lastFrameAssetId: request.lastFrame?.assetId ?? null,
    sourceVideoAssetId: request.kind === "VIDEO_EXTENSION" ? request.sourceVideoAssetId ?? null : null,
  };
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : "CREATOR_PROVIDER_ERROR").slice(0, 2000);
}

export async function submitCreatorGeneration(input: {
  workspaceId: number;
  creatorProjectId: number;
  shotId: number;
  idempotencyKey: string;
  request: CreatorMediaRequest;
  spend: CreatorSpendHook;
}) {
  const provider = selectCreatorProvider(input.request);
  const providerStatus = provider.status();
  const model = input.request.model ?? providerStatus.defaultModel;
  const spendInput = { kind: paidKindOf(input.request.kind), model, request: input.request };
  input.spend.price(spendInput);

  const queued = await createQueuedGeneration({
    workspaceId: input.workspaceId,
    creatorProjectId: input.creatorProjectId,
    shotId: input.shotId,
    idempotencyKey: input.idempotencyKey,
    kind: input.request.kind,
    provider: provider.id,
    model,
    parameters: creatorRequestProvenance(input.request),
    sourceAssetIds: sourceAssetIds(input.request),
  });
  const generationId = queued.generationId;

  if (!queued.created) {
    const { generation, providerJob } = await getGenerationExecutionContext(input.workspaceId, generationId);
    return {
      generationId,
      provider: generation.provider,
      providerState: providerJob?.status ?? generation.status,
      state: generation.status,
      outputAssetId: generation.outputAssetId ?? null,
      failureClass: generation.failureClass ?? null,
      errorMessage: generation.errorMessage ?? null,
      reused: true as const,
      productionApproved: false,
    };
  }

  try {
    await input.spend.reserve(spendInput);
  } catch (error) {
    // Denied or ledger unavailable: the generation never reaches the provider; record why (same key stays reused).
    await markGenerationFailed({
      workspaceId: input.workspaceId,
      creatorProjectId: input.creatorProjectId,
      generationId,
      failureClass: "QUOTA",
      errorMessage: errorMessage(error),
    }).catch(() => undefined);
    throw error;
  }

  try {
    await beginProviderSubmission({
      workspaceId: input.workspaceId,
      creatorProjectId: input.creatorProjectId,
      generationId,
    });
  } catch (error) {
    await input.spend.release();
    throw error;
  }

  let submission: Awaited<ReturnType<typeof provider.submit>>;
  try {
    submission = await provider.submit(input.request);
  } catch (error) {
    const failureClass = provider.classifyFailure(error);
    if (AMBIGUOUS_SUBMISSION_FAILURES.has(failureClass)) {
      // The provider may have accepted (and billed) the job: keep the reservation counted.
      await input.spend.markUnknown(generationId);
      await markGenerationSubmissionUnknown({
        workspaceId: input.workspaceId,
        creatorProjectId: input.creatorProjectId,
        generationId,
        failureClass,
        errorMessage: errorMessage(error),
      }).catch(() => undefined);
    } else {
      await input.spend.release();
      await markGenerationFailed({
        workspaceId: input.workspaceId,
        creatorProjectId: input.creatorProjectId,
        generationId,
        failureClass,
        errorMessage: errorMessage(error),
      }).catch(() => undefined);
    }
    throw error;
  }

  // Accepted by the provider: the spend is final, whatever happens to local bookkeeping next.
  await input.spend.commit(generationId);
  try {
    await recordProviderSubmission({
      workspaceId: input.workspaceId,
      creatorProjectId: input.creatorProjectId,
      generationId,
      submission,
    });
  } catch (error) {
    // Accepted but not persisted: reconciliation only, never resubmitted, never marked FAILED.
    await markGenerationSubmissionUnknown({
      workspaceId: input.workspaceId,
      creatorProjectId: input.creatorProjectId,
      generationId,
      failureClass: "UNKNOWN",
      errorMessage: errorMessage(error),
    }).catch(() => undefined);
    throw error;
  }
  return {
    generationId,
    provider: provider.id,
    providerState: submission.state,
    state: generationStateAfterProviderState(submission.state),
    outputAssetId: null,
    reused: false as const,
    productionApproved: false,
  };
}

export async function pollCreatorGeneration(input: { workspaceId: number; generationId: number }) {
  const { generation, providerJob } = await getGenerationExecutionContext(input.workspaceId, input.generationId);
  if (generation.status === "SUCCEEDED") {
    if (!generation.outputAssetId) throw new Error("CREATOR_SUCCEEDED_WITHOUT_OUTPUT_ASSET");
    return {
      generationId: generation.id,
      provider: generation.provider,
      providerState: providerJob?.status ?? "SUCCEEDED",
      state: "SUCCEEDED" as const,
      outputAssetId: generation.outputAssetId,
      failureClass: null,
      errorMessage: null,
      productionApproved: false,
    };
  }
  if (generation.status === "FAILED" || generation.status === "CANCELLED") {
    return {
      generationId: generation.id,
      provider: generation.provider,
      providerState: providerJob?.status ?? generation.status,
      state: generation.status,
      outputAssetId: null,
      failureClass: generation.failureClass,
      errorMessage: generation.errorMessage,
      productionApproved: false,
    };
  }
  if (!providerJob) {
    if (generation.status === "SUBMISSION_UNKNOWN") throw new Error("CREATOR_SUBMISSION_RECONCILIATION_REQUIRED");
    throw new Error("CREATOR_PROVIDER_JOB_NOT_FOUND");
  }

  const provider = getCreatorProvider(generation.provider);
  if (!provider) throw new Error("CREATOR_PROVIDER_NOT_REGISTERED");

  try {
    const poll = await provider.poll(providerJob.providerJobId);
    const persistedState = await recordProviderPoll({
      workspaceId: input.workspaceId,
      providerJobId: providerJob.providerJobId,
      poll,
    });
    if (poll.state !== "SUCCEEDED") {
      return {
        generationId: generation.id,
        provider: generation.provider,
        providerState: poll.state,
        state: persistedState.generationState,
        outputAssetId: null,
        failureClass: poll.failureClass ?? null,
        errorMessage: poll.errorMessage ?? null,
        productionApproved: false,
      };
    }

    const artifact = poll.artifacts[0];
    if (!artifact) throw new Error("CREATOR_PROVIDER_ARTIFACT_MISSING");
    try {
      const stored = await persistCreatorGenerationArtifact({
        workspaceId: input.workspaceId,
        generationId: generation.id,
        providerJobId: providerJob.providerJobId,
        provider,
        artifact,
      });
      return {
        generationId: generation.id,
        provider: generation.provider,
        providerState: "SUCCEEDED" as const,
        state: "SUCCEEDED" as const,
        outputAssetId: stored.assetId,
        storageKey: stored.storageKey,
        checksumSha256: stored.checksumSha256,
        reused: stored.reused,
        failureClass: null,
        errorMessage: null,
        productionApproved: false,
      };
    } catch (artifactError) {
      await markCreatorArtifactRetryable({
        workspaceId: input.workspaceId,
        generationId: generation.id,
        error: artifactError,
      });
      return {
        generationId: generation.id,
        provider: generation.provider,
        providerState: "SUCCEEDED" as const,
        state: "RETRYABLE" as const,
        outputAssetId: null,
        failureClass: "ARTIFACT" as const,
        errorMessage: errorMessage(artifactError),
        productionApproved: false,
      };
    }
  } catch (error) {
    const failureClass = provider.classifyFailure(error);
    if (providerJob.status === "SUCCEEDED") {
      await markCreatorArtifactRetryable({ workspaceId: input.workspaceId, generationId: generation.id, error }).catch(() => undefined);
      return {
        generationId: generation.id,
        provider: generation.provider,
        providerState: "SUCCEEDED" as const,
        state: "RETRYABLE" as const,
        outputAssetId: null,
        failureClass: "ARTIFACT" as const,
        errorMessage: errorMessage(error),
        productionApproved: false,
      };
    }

    const nextState = RETRYABLE_FAILURES.has(failureClass) ? "RETRYABLE" as const : "FAILED" as const;
    await recordProviderPoll({
      workspaceId: input.workspaceId,
      providerJobId: providerJob.providerJobId,
      poll: {
        providerJobId: providerJob.providerJobId,
        state: nextState,
        raw: { error: errorMessage(error) },
        artifacts: [],
        failureClass,
        errorMessage: errorMessage(error),
      },
    }).catch(() => undefined);
    return {
      generationId: generation.id,
      provider: generation.provider,
      providerState: nextState,
      state: nextState,
      outputAssetId: null,
      failureClass,
      errorMessage: errorMessage(error),
      productionApproved: false,
    };
  }
}

export async function retryCreatorGeneration(
  input: { workspaceId: number; generationId: number },
  authorize: (kind: CreatorPaidKind) => Promise<void>,
) {
  const { generation, providerJob } = await getGenerationExecutionContext(input.workspaceId, input.generationId);
  await authorize(paidKindOf(generation.kind));
  const retryMode = resolveCreatorRetryMode({
    generationState: generation.status as CreatorJobState,
    failureClass: generation.failureClass as CreatorFailureClass | null,
    providerJobState: providerJob?.status as CreatorJobState | null | undefined,
  });

  const result = await pollCreatorGeneration(input);
  return { ...result, retryMode, regeneratedMedia: false as const };
}

export async function cancelCreatorGeneration(input: { workspaceId: number; generationId: number }) {
  const { generation, providerJob } = await getGenerationExecutionContext(input.workspaceId, input.generationId);
  if (["SUCCEEDED", "FAILED", "CANCELLED"].includes(generation.status)) {
    throw new Error(`CREATOR_GENERATION_NOT_CANCELLABLE_${generation.status}`);
  }
  if (!providerJob) throw new Error("CREATOR_PROVIDER_JOB_NOT_FOUND");

  const provider = getCreatorProvider(generation.provider);
  if (!provider) throw new Error("CREATOR_PROVIDER_NOT_REGISTERED");
  const remoteCancel = requireCreatorRemoteCancel(provider);
  const poll = await remoteCancel(providerJob.providerJobId);
  const persistedState = await recordProviderPoll({
    workspaceId: input.workspaceId,
    providerJobId: providerJob.providerJobId,
    poll,
  });

  return {
    generationId: generation.id,
    provider: generation.provider,
    providerState: poll.state,
    state: persistedState.generationState,
    cancellationAcknowledged: poll.state === "CANCELLED",
    outputAssetId: null,
    failureClass: poll.failureClass ?? null,
    errorMessage: poll.errorMessage ?? null,
    productionApproved: false,
  };
}
