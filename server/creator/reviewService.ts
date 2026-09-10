import { and, eq } from "drizzle-orm";
import { creatorAssets, creatorReviews, creatorTimelines } from "../../drizzle/schema";
import { getDb } from "../db";
import { scoreCreatorRenderQuality, type CreatorQualityReviewerType } from "./qualityGate";

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

  const [timeline] = await db.select().from(creatorTimelines).where(and(
    eq(creatorTimelines.id, Number(provenance.timelineId)),
    eq(creatorTimelines.workspaceId, input.workspaceId),
    eq(creatorTimelines.creatorProjectId, input.creatorProjectId),
  )).limit(1);
  if (!timeline || !timeline.audioMasterAssetId) throw new Error("CREATOR_QUALITY_TIMELINE_NOT_FOUND");
  if (timeline.audioMasterAssetId !== Number(provenance.audioMasterAssetId)) throw new Error("CREATOR_QUALITY_AUDIO_MASTER_DRIFT");

  const score = scoreCreatorRenderQuality({
    reviewerType: input.reviewerType,
    dimensionScores: input.dimensionScores,
    criticalDefects: input.criticalDefects,
    actual: {
      width: Number(provenance.width),
      height: Number(provenance.height),
      fps: Number(provenance.fps),
      durationSeconds: Number(provenance.durationMs) / 1000,
      hasAudio: Boolean(provenance.audioMasterAssetId && provenance.audioMasterChecksumSha256),
    },
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
