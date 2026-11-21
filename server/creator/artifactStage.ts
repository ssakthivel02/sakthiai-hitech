import { createHash } from "node:crypto";
export type CreatorStagedArtifact = { storageKey: string; checksumSha256: string; byteSize: number; mimeType: string };
export function creatorArtifactStageKey(input: {
  workspaceId: number; creatorProjectId: number; generationId: number;
  provider: string; providerJobId: string; checksumSha256: string; extension: string;
}): string {
  for (const n of [input.workspaceId, input.creatorProjectId, input.generationId])
    if (!Number.isSafeInteger(n) || n < 1) throw new Error("CREATOR_ARTIFACT_STAGE_SCOPE_INVALID");
  if (!input.provider || !input.providerJobId || !/^[a-f0-9]{64}$/.test(input.checksumSha256) ||
      !/^(png|jpg|webp|mp4|wav)$/.test(input.extension))
    throw new Error("CREATOR_ARTIFACT_STAGE_IDENTITY_INVALID");
  const jobHash = createHash("sha256").update(input.provider).update("\0").update(input.providerJobId).digest("hex").slice(0, 32);
  return `creator/${input.workspaceId}/${input.creatorProjectId}/staged/generation-${input.generationId}/job-${jobHash}/${input.checksumSha256}.${input.extension}`;
}
export function assertCreatorStagedArtifactMatches(a: CreatorStagedArtifact, b: CreatorStagedArtifact): void {
  if (a.storageKey !== b.storageKey || a.checksumSha256 !== b.checksumSha256 ||
      a.byteSize !== b.byteSize || a.mimeType !== b.mimeType)
    throw new Error("CREATOR_ARTIFACT_STAGE_IDENTITY_CHANGED");
}
