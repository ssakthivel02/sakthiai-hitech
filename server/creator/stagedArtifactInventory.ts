import { createHash } from "node:crypto";

export type StagedArtifactIdentity = {
  workspaceId: number;
  creatorProjectId: number;
  generationId: number;
  jobHash: string;
  checksumSha256: string;
  extension: string;
};

export type StagedArtifactFinding =
  | "INVALID_STAGE_KEY"
  | "REFERENCED_ASSET"
  | "ACTIVE_UPLOAD"
  | "RECOVERABLE_STAGE"
  | "UNREFERENCED_CANDIDATE"
  | "OWNERSHIP_CONFLICT"
  | "STORAGE_UNVERIFIED";

export type StagedArtifactEvidence = {
  object: { key: string; sizeBytes: number };
  nowMs: number;
  generation: null | {
    id: number; workspaceId: number; creatorProjectId: number;
    provider: string; status: string; outputAssetId: number | null;
  };
  latestJob: null | {
    workspaceId: number; creatorProjectId: number; generationId: number;
    provider: string; providerJobId: string; status: string;
  };
  lease: null | {
    workspaceId: number; creatorProjectId: number; generationId: number;
    providerJobId: string; leaseUntil: Date;
    stagedStorageKey: string | null; stagedChecksumSha256: string | null;
    stagedByteSize: number | null; stagedMimeType: string | null;
  };
  assets: Array<{
    id: number; workspaceId: number; creatorProjectId: number;
    storageKey: string; checksumSha256: string; byteSize: number | null;
  }>;
  verified: "PASS" | "FAIL" | "NOT_CHECKED";
};

const STAGED_KEY = /^creator\/([1-9]\d*)\/([1-9]\d*)\/staged\/generation-([1-9]\d*)\/job-([a-f0-9]{32})\/([a-f0-9]{64})\.(png|jpg|webp|mp4|wav)$/;
const MIME_BY_EXT: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", webp: "image/webp",
  mp4: "video/mp4", wav: "audio/wav",
};

/** A malformed stage key is never considered eligible for recovery or cleanup. */
export function parseCreatorStagedKey(key: string): StagedArtifactIdentity | null {
  const match = STAGED_KEY.exec(key);
  if (!match) return null;
  const [workspaceId, creatorProjectId, generationId] = match.slice(1, 4).map(Number);
  if (![workspaceId, creatorProjectId, generationId].every(Number.isSafeInteger)) return null;
  return {
    workspaceId, creatorProjectId, generationId,
    jobHash: match[4], checksumSha256: match[5], extension: match[6],
  };
}

export function isCreatorStagedCandidate(key: string): boolean {
  return key.startsWith("creator/") && key.includes("/staged/");
}

/**
 * Snapshot-only classification. Never treat UNREFERENCED_CANDIDATE as permission
 * to delete: a DB transaction or object upload may be concurrently in flight.
 */
export function classifyCreatorStagedArtifact(e: StagedArtifactEvidence): StagedArtifactFinding {
  const parsed = parseCreatorStagedKey(e.object.key);
  if (!parsed || !Number.isSafeInteger(e.object.sizeBytes) || e.object.sizeBytes < 1 ||
      !Number.isFinite(e.nowMs)) return "INVALID_STAGE_KEY";
  const scoped = (row: { workspaceId: number; creatorProjectId: number }) =>
    row.workspaceId === parsed.workspaceId && row.creatorProjectId === parsed.creatorProjectId;

  if (e.assets.length > 0) {
    if (e.assets.length !== 1) return "OWNERSHIP_CONFLICT";
    const asset = e.assets[0];
    if (!scoped(asset) || asset.storageKey !== e.object.key ||
        asset.checksumSha256 !== parsed.checksumSha256 || asset.byteSize !== e.object.sizeBytes ||
        !e.generation || !scoped(e.generation) ||
        e.generation.id !== parsed.generationId || e.generation.outputAssetId !== asset.id ||
        e.generation.status !== "SUCCEEDED") return "OWNERSHIP_CONFLICT";
    return e.verified === "PASS" ? "REFERENCED_ASSET" : "STORAGE_UNVERIFIED";
  }

  if (!e.lease) return "UNREFERENCED_CANDIDATE";
  const lease = e.lease;
  const generation = e.generation;
  const job = e.latestJob;
  if (!scoped(lease) || lease.generationId !== parsed.generationId ||
      lease.stagedStorageKey !== e.object.key ||
      lease.stagedChecksumSha256 !== parsed.checksumSha256 ||
      lease.stagedByteSize !== e.object.sizeBytes ||
      lease.stagedMimeType !== MIME_BY_EXT[parsed.extension] ||
      !generation || !scoped(generation) || generation.id !== parsed.generationId ||
      generation.outputAssetId !== null ||
      !job || !scoped(job) || job.generationId !== parsed.generationId ||
      job.provider !== generation.provider || job.providerJobId !== lease.providerJobId ||
      job.status !== "SUCCEEDED" ||
      createHash("sha256").update(job.provider).update("\0").update(job.providerJobId)
        .digest("hex").slice(0, 32) !== parsed.jobHash) {
    return "OWNERSHIP_CONFLICT";
  }
  if (!Number.isFinite(lease.leaseUntil.getTime())) return "OWNERSHIP_CONFLICT";
  if (lease.leaseUntil.getTime() > e.nowMs) return "ACTIVE_UPLOAD";
  if (!["RUNNING", "SUBMITTED", "RETRYABLE"].includes(generation.status)) return "OWNERSHIP_CONFLICT";
  return e.verified === "PASS" ? "RECOVERABLE_STAGE" : "STORAGE_UNVERIFIED";
}
