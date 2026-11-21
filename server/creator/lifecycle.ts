import type { CreatorJobState, CreatorProviderPoll, CreatorProviderSubmission } from "./types";

type ProviderState = CreatorProviderSubmission["state"] | CreatorProviderPoll["state"];

/**
 * Provider completion is not SakthiAI generation completion. A successful
 * provider output remains RUNNING until SakthiAI has durably persisted and
 * checksummed the generated artifact.
 */
export function generationStateAfterProviderState(providerState: ProviderState): CreatorJobState {
  return providerState === "SUCCEEDED" ? "RUNNING" : providerState;
}
