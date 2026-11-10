/** Fail closed when an artifact belongs to a stale, foreign, or unfinished provider job. */
export interface CreatorArtifactProviderJob {
  workspaceId: number;
  creatorProjectId: number;
  generationId: number;
  provider: string;
  providerJobId: string;
  status: string;
}

export function assertCreatorArtifactJobOwnership(input: {
  workspaceId: number;
  creatorProjectId: number;
  generationId: number;
  provider: string;
  providerJobId: string;
  job: CreatorArtifactProviderJob | null;
}): void {
  const { job } = input;
  if (
    !job ||
    !input.providerJobId ||
    job.workspaceId !== input.workspaceId ||
    job.creatorProjectId !== input.creatorProjectId ||
    job.generationId !== input.generationId ||
    job.provider !== input.provider ||
    job.providerJobId !== input.providerJobId
  ) {
    throw new Error("CREATOR_ARTIFACT_PROVIDER_JOB_MISMATCH");
  }
  if (job.status !== "SUCCEEDED") {
    throw new Error("CREATOR_ARTIFACT_PROVIDER_JOB_NOT_SUCCEEDED");
  }
}

export function isCreatorArtifactJobOwnershipError(error: unknown): boolean {
  return error instanceof Error &&
    (error.message === "CREATOR_ARTIFACT_PROVIDER_JOB_MISMATCH" ||
      error.message === "CREATOR_ARTIFACT_PROVIDER_JOB_NOT_SUCCEEDED" ||
      error.message === "CREATOR_PROVIDER_JOB_SUPERSEDED" ||
      error.message === "CREATOR_PROVIDER_POLL_JOB_MISMATCH" ||
      error.message === "CREATOR_PROVIDER_JOB_AMBIGUOUS" ||
      error.message === "CREATOR_PROVIDER_POLL_ALREADY_FINALIZED" ||
      error.message === "CREATOR_ARTIFACT_LEASE_BUSY" ||
      error.message === "CREATOR_ARTIFACT_LEASE_LOST" ||
      error.message === "CREATOR_ARTIFACT_ALREADY_FINALIZED");
}
