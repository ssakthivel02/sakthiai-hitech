import { and, eq } from "drizzle-orm";
import { creatorAssets, creatorReviews, creatorTimelines } from "../../drizzle/schema";
import { getDb } from "../db";
import { storageVerifySha256 } from "../storage";
import { scoreCreatorRenderQuality, type CreatorOutputEvidence, type CreatorQualityReviewerType } from "./qualityGate";

async function requireDb() {
  const db = await getDb();
  if (!db) throw new Error("CREATOR_DATABASE_UNAVAILABLE");
  return db;
}

function parseRenderProvenance(value: string) {
  try {
    const parsed = JSON.parse(value) as {
      source?: unknown;
      timelineId?: unknown;
      audioMasterAssetId?: unknown;
      audioMasterChecksumSha256?: unknown;
      width?: unknown;
      height?: unknown;
      fps?: unknown;
      durationMs?: unknown;
      outputEvidence?: unknown;
    };
    if (
      parsed.source === "deterministic-creator-render" &&
      Number.isInteger(parsed.timelineId) &&
      Number.isInteger(parsed.audioMasterAssetId) &&
      typeof parsed.audioMasterChecksumSha256 === "string" &&
      Number.isInteger(parsed.width) &&
      Number.isInteger(parsed.height) &&
      typeof parsed.fps === "number" &&
      Number.isInteger(parsed.durationMs)
    ) return parsed as Required<typeof parsed>;
  } catch {
    // Fall through to bounded Creator error.
  }
  throw new Error("CREATOR_REVIEW_RENDER_PROVENANCE_INVALID");
}

/**
 * Use FFprobe-derived evidence persisted by the renderer, not source metadata
 * masquerading as proof that the output contains video/audio. Older render
 * assets without measured evidence must be re-qualified before quality PASS.
 */
function requireMeasuredOutputEvidence(provenance: {
  outputEvidence?: unknown; width?: unknown; height?: unknown; fps?: unknown; durationMs?: unknown;
}): CreatorOutputEvidence {
  const raw = provenance.outputEvidence;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("CREATOR_QUALITY_OUTPUT_EVIDENCE_REQUIRED");
  }
  const value = raw as Record<string, unknown>;
  if (!Number.isSafeInteger(value.width) || Number(value.width) <= 0 ||
      !Number.isSafeInteger(value.height) || Number(value.height) <= 0 ||
      typeof value.fps !== "number" || !Number.isFinite(value.fps) || value.fps <= 0 ||
      typeof value.durationSeconds !== "number" || !Number.isFinite(value.durationSeconds) ||
      value.durationSeconds <= 0 || typeof value.hasAudio !== "boolean") {
    throw new Error("CREATOR_QUALITY_OUTPUT_EVIDENCE_INVALID");
  }
  const measured: CreatorOutputEvidence = {
    width: Number(value.width), height: Number(value.height),
    fps: value.fps, durationSeconds: value.durationSeconds, hasAudio: value.hasAudio,
  };
  if (measured.width !== provenance.width || measured.height !== provenance.height ||
      Math.abs(measured.fps - Number(provenance.fps)) > 0.01 ||
      Math.abs(measured.durationSeconds * 1000 - Number(provenance.durationMs)) > 100) {
    throw new Error("CREATOR_QUALITY_OUTPUT_EVIDENCE_DRIFT");
  }
  return measured;
}

async function requireRenderAsset(input: { workspaceId: number; creatorProjectId: number; assetId: number }) {
  const db = await requireDb();
  const [asset] = await db.select().from(creatorAssets).where(and(
    eq(creatorAssets.id, input.assetId),
    eq(creatorAssets.workspaceId, input.workspaceId),
    eq(creatorAssets.creatorProjectId, input.creatorProjectId),
  )).limit(1);
  if (!asset || asset.assetType !== "RENDER" || asset.immutable !== 1) throw new Error("CREATOR_REVIEW_RENDER_NOT_FOUND");
  return { db, asset, provenance: parseRenderProvenance(asset.provenanceJson) };
}


type CandidateArtifactIdentity = { storageKey: string; checksumSha256: string; byteSize: number };

function candidateArtifactIdentity(asset: typeof creatorAssets.$inferSelect): CandidateArtifactIdentity {
  if (typeof asset.storageKey !== "string" || !asset.storageKey.trim() ||
      typeof asset.checksumSha256 !== "string" || !/^[a-f0-9]{64}$/.test(asset.checksumSha256) ||
      !Number.isSafeInteger(asset.byteSize) || Number(asset.byteSize) <= 0) {
    throw new Error("CREATOR_REVIEW_CANDIDATE_IDENTITY_INVALID");
  }
  return { storageKey: asset.storageKey, checksumSha256: asset.checksumSha256, byteSize: Number(asset.byteSize) };
}

/** The scored bytes must still exist and match the immutable render record. */
async function verifyCandidateBytes(asset: typeof creatorAssets.$inferSelect): Promise<CandidateArtifactIdentity> {
  const identity = candidateArtifactIdentity(asset);
  try {
    await storageVerifySha256(identity.storageKey, identity.byteSize, identity.checksumSha256);
  } catch {
    // Do not disclose storage credentials, URLs, or backend errors through review APIs.
    throw new Error("CREATOR_REVIEW_CANDIDATE_STORAGE_UNVERIFIED");
  }
  return identity;
}

/** Reject stale or pre-binding quality reviews; never promote a different artifact under the same asset ID. */
function assertQualityCandidateBinding(scoresJson: string | null, asset: typeof creatorAssets.$inferSelect): void {
  let stored: unknown;
  try {
    stored = JSON.parse(scoresJson ?? "");
  } catch {
    throw new Error("CREATOR_REVIEW_CANDIDATE_IDENTITY_MISSING");
  }
  if (!stored || typeof stored !== "object" || Array.isArray(stored) ||
      !("candidateArtifact" in stored)) {
    throw new Error("CREATOR_REVIEW_CANDIDATE_IDENTITY_MISSING");
  }
  const bound = (stored as { candidateArtifact: unknown }).candidateArtifact;
  const current = candidateArtifactIdentity(asset);
  if (!bound || typeof bound !== "object" || Array.isArray(bound) ||
      (bound as CandidateArtifactIdentity).storageKey !== current.storageKey ||
      (bound as CandidateArtifactIdentity).checksumSha256 !== current.checksumSha256 ||
      (bound as CandidateArtifactIdentity).byteSize !== current.byteSize) {
    throw new Error("CREATOR_REVIEW_CANDIDATE_IDENTITY_DRIFT");
  }
}

async function ensureReviewAbsent(input: {
  workspaceId: number;
  creatorProjectId: number;
  assetId: number;
  reviewType: "QUALITY" | "HUMAN_TAMIL" | "HUMAN_VISUAL";
}) {
  const db = await requireDb();
  const [existing] = await db.select({ id: creatorReviews.id }).from(creatorReviews).where(and(
    eq(creatorReviews.workspaceId, input.workspaceId),
    eq(creatorReviews.creatorProjectId, input.creatorProjectId),
    eq(creatorReviews.assetId, input.assetId),
    eq(creatorReviews.reviewType, input.reviewType),
  )).limit(1);
  if (existing) throw new Error(`CREATOR_${input.reviewType}_REVIEW_ALREADY_RECORDED`);
}

export async function recordCreatorQualityReview(input: {
  workspaceId: number;
  creatorProjectId: number;
  assetId: number;
  reviewerUserId: number;
  reviewerType: CreatorQualityReviewerType;
  sourcePromptOrStoryboard: string;
  dimensionScores: Record<string, number>;
  criticalDefects: string[];
  notes?: string;
}) {
  const { db, asset, provenance } = await requireRenderAsset(input);
  if (asset.reviewDecision !== "PENDING") throw new Error("CREATOR_QUALITY_REVIEW_ASSET_ALREADY_FINAL");
  await ensureReviewAbsent({ ...input, reviewType: "QUALITY" });
  const candidateArtifact = await verifyCandidateBytes(asset);

  const [timeline] = await db.select().from(creatorTimelines).where(and(
    eq(creatorTimelines.id, Number(provenance.timelineId)),
    eq(creatorTimelines.workspaceId, input.workspaceId),
    eq(creatorTimelines.creatorProjectId, input.creatorProjectId),
  )).limit(1);
  if (!timeline || !timeline.audioMasterAssetId) throw new Error("CREATOR_QUALITY_TIMELINE_NOT_FOUND");
  if (timeline.audioMasterAssetId !== Number(provenance.audioMasterAssetId)) throw new Error("CREATOR_QUALITY_AUDIO_MASTER_DRIFT");

  const measuredOutput = requireMeasuredOutputEvidence(provenance);
  const score = scoreCreatorRenderQuality({
    reviewerType: input.reviewerType,
    dimensionScores: input.dimensionScores,
    criticalDefects: input.criticalDefects,
    actual: measuredOutput,
    target: {
      width: timeline.width,
      height: timeline.height,
      fps: timeline.fps,
      durationSeconds: Number(provenance.durationMs) / 1000,
      hasAudio: true,
    },
  });

  const decision = score.decision === "PUBLISH_CANDIDATE"
    ? "PASS"
    : score.decision === "PREVIEW_CANDIDATE"
      ? "ASSISTED_HUMAN_REVIEW"
      : score.decision;

  const inserted = await db.insert(creatorReviews).values({
    workspaceId: input.workspaceId,
    creatorProjectId: input.creatorProjectId,
    assetId: input.assetId,
    reviewType: "QUALITY",
    decision,
    reviewerUserId: input.reviewerUserId,
    scoresJson: JSON.stringify({
      reviewerType: input.reviewerType,
      sourcePromptOrStoryboard: input.sourcePromptOrStoryboard,
      candidateArtifact,
      ...score,
    }),
    notes: input.notes?.trim() || null,
  });
  const reviewId = Number(inserted[0].insertId);
  if (!reviewId) throw new Error("CREATOR_QUALITY_REVIEW_CREATE_FAILED");

  if (score.decision === "REJECT") {
    await db.update(creatorAssets).set({ reviewDecision: "REJECTED" }).where(and(
      eq(creatorAssets.id, input.assetId),
      eq(creatorAssets.workspaceId, input.workspaceId),
    ));
  }
  return { reviewId, assetId: input.assetId, decision, quality: score, finalMaster: false, publishApproved: false };
}

export async function recordCreatorHumanReview(input: {
  workspaceId: number;
  creatorProjectId: number;
  assetId: number;
  reviewerUserId: number;
  reviewType: "HUMAN_TAMIL" | "HUMAN_VISUAL";
  decision: "PASS" | "REJECT";
  notes: string;
}) {
  const { db, asset } = await requireRenderAsset(input);
  if (asset.reviewDecision !== "PENDING") throw new Error("CREATOR_HUMAN_REVIEW_ASSET_ALREADY_FINAL");
  if (!input.notes.trim()) throw new Error("CREATOR_HUMAN_REVIEW_NOTES_REQUIRED");
  await ensureReviewAbsent(input);

  const [quality] = await db.select().from(creatorReviews).where(and(
    eq(creatorReviews.workspaceId, input.workspaceId),
    eq(creatorReviews.creatorProjectId, input.creatorProjectId),
    eq(creatorReviews.assetId, input.assetId),
    eq(creatorReviews.reviewType, "QUALITY"),
  )).limit(1);
  if (!quality) throw new Error("CREATOR_QUALITY_REVIEW_REQUIRED_FIRST");
  assertQualityCandidateBinding(quality.scoresJson, asset);
  if (quality.decision === "REGENERATE" || quality.decision === "REJECT") throw new Error("CREATOR_HUMAN_REVIEW_BLOCKED_BY_QUALITY");

  const inserted = await db.insert(creatorReviews).values({
    workspaceId: input.workspaceId,
    creatorProjectId: input.creatorProjectId,
    assetId: input.assetId,
    reviewType: input.reviewType,
    decision: input.decision,
    reviewerUserId: input.reviewerUserId,
    notes: input.notes.trim(),
  });
  const reviewId = Number(inserted[0].insertId);
  if (!reviewId) throw new Error("CREATOR_HUMAN_REVIEW_CREATE_FAILED");

  if (input.decision === "REJECT") {
    await db.update(creatorAssets).set({ reviewDecision: "REJECTED" }).where(and(
      eq(creatorAssets.id, input.assetId),
      eq(creatorAssets.workspaceId, input.workspaceId),
    ));
  }
  return { reviewId, assetId: input.assetId, reviewType: input.reviewType, decision: input.decision, finalMaster: false, publishApproved: false };
}

export async function finalizeCreatorMaster(input: {
  workspaceId: number;
  creatorProjectId: number;
  assetId: number;
}) {
  const { db, asset } = await requireRenderAsset(input);
  if (asset.reviewDecision === "REJECTED") throw new Error("CREATOR_FINAL_MASTER_REJECTED");
  if (asset.reviewDecision === "APPROVED") throw new Error("CREATOR_FINAL_MASTER_ALREADY_APPROVED");

  const reviews = await db.select().from(creatorReviews).where(and(
    eq(creatorReviews.workspaceId, input.workspaceId),
    eq(creatorReviews.creatorProjectId, input.creatorProjectId),
    eq(creatorReviews.assetId, input.assetId),
  ));
  const quality = reviews.find(review => review.reviewType === "QUALITY");
  const tamil = reviews.find(review => review.reviewType === "HUMAN_TAMIL");
  const visual = reviews.find(review => review.reviewType === "HUMAN_VISUAL");
  if (quality?.decision !== "PASS") throw new Error("CREATOR_FINAL_MASTER_QUALITY_PASS_REQUIRED");
  if (tamil?.decision !== "PASS") throw new Error("CREATOR_FINAL_MASTER_TAMIL_PASS_REQUIRED");
  if (visual?.decision !== "PASS") throw new Error("CREATOR_FINAL_MASTER_VISUAL_PASS_REQUIRED");
  if (!quality.reviewerUserId || !tamil.reviewerUserId || !visual.reviewerUserId) throw new Error("CREATOR_FINAL_MASTER_HUMAN_EVIDENCE_REQUIRED");
  assertQualityCandidateBinding(quality.scoresJson, asset);
  await verifyCandidateBytes(asset);

  await db.update(creatorAssets).set({ reviewDecision: "APPROVED" }).where(and(
    eq(creatorAssets.id, input.assetId),
    eq(creatorAssets.workspaceId, input.workspaceId),
    eq(creatorAssets.creatorProjectId, input.creatorProjectId),
  ));
  return {
    assetId: input.assetId,
    checksumSha256: asset.checksumSha256,
    finalMaster: true,
    qualityPass: true,
    humanTamilPass: true,
    humanVisualPass: true,
    publishApproved: false,
    automaticPublish: false,
  };
}
