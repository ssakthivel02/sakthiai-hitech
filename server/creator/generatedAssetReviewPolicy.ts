export type GeneratedAssetReviewTarget = {
  id: number;
  workspaceId: number;
  creatorProjectId: number;
  shotId: number | null;
  assetType: string;
  mimeType: string;
  immutable: number;
  reviewDecision: string;
  checksumSha256: string;
  byteSize: number | null;
  storageKey: string;
  provenanceJson: string;
};

export type GeneratedReviewIdentity = {
  generationId: number;
  provider: string;
  providerJobId: string;
};

export function assertGeneratedAssetReviewTarget(
  asset: GeneratedAssetReviewTarget | undefined,
  input: { workspaceId: number; creatorProjectId: number; assetId: number; expectedChecksumSha256: string },
): GeneratedReviewIdentity {
  if (!asset || asset.id !== input.assetId ||
      asset.workspaceId !== input.workspaceId || asset.creatorProjectId !== input.creatorProjectId) {
    throw new Error("CREATOR_GENERATED_REVIEW_ASSET_NOT_FOUND");
  }
  if (asset.assetType !== "IMAGE" && asset.assetType !== "VIDEO") {
    throw new Error("CREATOR_GENERATED_REVIEW_TYPE_INVALID");
  }
  if (asset.immutable !== 1 || asset.reviewDecision !== "PENDING") {
    throw new Error("CREATOR_GENERATED_REVIEW_ALREADY_DECIDED");
  }
  if (asset.assetType === "IMAGE" && !["image/png", "image/jpeg", "image/webp"].includes(asset.mimeType) ||
      asset.assetType === "VIDEO" && asset.mimeType !== "video/mp4") {
    throw new Error("CREATOR_GENERATED_REVIEW_MIME_INVALID");
  }
  if (!/^[a-f0-9]{64}$/.test(asset.checksumSha256) ||
      asset.checksumSha256 !== input.expectedChecksumSha256 ||
      !Number.isSafeInteger(asset.byteSize) || (asset.byteSize ?? 0) < 1 ||
      !asset.storageKey.startsWith(`creator/${input.workspaceId}/${input.creatorProjectId}/`)) {
    throw new Error("CREATOR_GENERATED_REVIEW_ARTIFACT_EVIDENCE_MISMATCH");
  }
  let provenance: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(asset.provenanceJson);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid");
    provenance = value as Record<string, unknown>;
  } catch {
    throw new Error("CREATOR_GENERATED_REVIEW_PROVENANCE_INVALID");
  }
  if (!Number.isSafeInteger(provenance.generationId) || Number(provenance.generationId) < 1 ||
      typeof provenance.provider !== "string" || !provenance.provider.trim() ||
      typeof provenance.providerJobId !== "string" || !provenance.providerJobId.trim() ||
      provenance.creatorProjectId !== input.creatorProjectId ||
      provenance.checksumSha256 !== asset.checksumSha256 ||
      (provenance.shotId ?? null) !== asset.shotId) {
    throw new Error("CREATOR_GENERATED_REVIEW_PROVENANCE_INVALID");
  }
  return {
    generationId: Number(provenance.generationId),
    provider: provenance.provider,
    providerJobId: provenance.providerJobId,
  };
}

export function assertGeneratedReviewGeneration(
  generation: { id: number; workspaceId: number; creatorProjectId: number; shotId: number | null; outputAssetId: number | null; provider: string; status: string; kind: string } | undefined,
  asset: GeneratedAssetReviewTarget,
  identity: GeneratedReviewIdentity,
): void {
  if (!generation || generation.id !== identity.generationId ||
      generation.workspaceId !== asset.workspaceId || generation.creatorProjectId !== asset.creatorProjectId ||
      generation.outputAssetId !== asset.id || generation.status !== "SUCCEEDED" ||
      generation.provider !== identity.provider || generation.shotId !== asset.shotId ||
      (asset.assetType === "IMAGE" ? !["IMAGE", "IMAGE_EDIT"].includes(generation.kind) : !["VIDEO", "VIDEO_EXTENSION", "AVATAR_VIDEO"].includes(generation.kind))) {
    throw new Error("CREATOR_GENERATED_REVIEW_GENERATION_MISMATCH");
  }
}

export function assertGeneratedReviewProviderJob(
  job: { workspaceId: number; creatorProjectId: number; generationId: number; provider: string; providerJobId: string; status: string } | undefined,
  asset: GeneratedAssetReviewTarget,
  identity: GeneratedReviewIdentity,
): void {
  if (!job || job.workspaceId !== asset.workspaceId || job.creatorProjectId !== asset.creatorProjectId ||
      job.generationId !== identity.generationId || job.provider !== identity.provider ||
      job.providerJobId !== identity.providerJobId || job.status !== "SUCCEEDED") {
    throw new Error("CREATOR_GENERATED_REVIEW_PROVIDER_JOB_MISMATCH");
  }
}
