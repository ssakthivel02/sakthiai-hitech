import type { CreatorFailureClass, CreatorJobState, CreatorMediaProvider } from "./types";

export type CreatorRetryMode = "REPOLL_EXISTING_PROVIDER_JOB" | "REPOLL_COMPLETED_JOB_FOR_ARTIFACT";

export function resolveCreatorRetryMode(input: {
  generationState: CreatorJobState;
  failureClass?: CreatorFailureClass | null;
  providerJobState?: CreatorJobState | null;
}): CreatorRetryMode {
  if (input.generationState !== "RETRYABLE") {
    throw new Error("CREATOR_GENERATION_NOT_RETRYABLE");
  }
  if (!input.providerJobState) {
    throw new Error("CREATOR_PROVIDER_JOB_NOT_FOUND");
  }

  if (input.failureClass === "ARTIFACT" || input.providerJobState === "SUCCEEDED") {
    return "REPOLL_COMPLETED_JOB_FOR_ARTIFACT";
  }

  if (["SUBMITTED", "RUNNING", "RETRYABLE"].includes(input.providerJobState)) {
    return "REPOLL_EXISTING_PROVIDER_JOB";
  }

  throw new Error("CREATOR_RETRY_REQUIRES_NEW_GENERATION");
}

export function requireCreatorRemoteCancel(provider: CreatorMediaProvider): NonNullable<CreatorMediaProvider["cancel"]> {
  if (!provider.cancel) {
    throw new Error("CREATOR_PROVIDER_CANCEL_UNSUPPORTED");
  }
  return provider.cancel.bind(provider);
}
