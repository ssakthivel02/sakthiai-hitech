import { and, desc, eq } from "drizzle-orm";
import { creatorAssets, creatorGenerations, creatorProviderJobs, creatorReviews } from "../../drizzle/schema";
import { getDb } from "../db";
import { storageVerifySha256 } from "../storage";
import {
  assertGeneratedAssetReviewTarget,
  assertGeneratedReviewGeneration,
  assertGeneratedReviewProviderJob,
} from "./generatedAssetReviewPolicy";

export async function reviewCreatorGeneratedAsset(input: {
  workspaceId: number;
  creatorProjectId: number;
  assetId: number;
  expectedChecksumSha256: string;
  decision: "APPROVE" | "REJECT";
  notes: string;
  reviewerUserId: number;
}) {
  const db = await getDb();
  if (!db) throw new Error("CREATOR_DATABASE_UNAVAILABLE");
  const scope = and(
    eq(creatorAssets.id, input.assetId),
    eq(creatorAssets.workspaceId, input.workspaceId),
    eq(creatorAssets.creatorProjectId, input.creatorProjectId),
  );
  const [asset] = await db.select().from(creatorAssets).where(scope).limit(1);
  const identity = assertGeneratedAssetReviewTarget(asset, input);

  // A PASS requires evidence from actual stored bytes, not only provider status or DB metadata.
  // REJECT remains available when a corrupt/missing object cannot be played.
  if (input.decision === "APPROVE") {
    await storageVerifySha256(asset!.storageKey, asset!.byteSize!, asset!.checksumSha256);
  }

  // Match the generation-row lock order used by provider submission/finalization.
  // An asset-row lock serializes duplicate human decisions without a new migration.
  return db.transaction(async tx => {
    const [generation] = await tx.select().from(creatorGenerations).where(and(
      eq(creatorGenerations.id, identity.generationId),
      eq(creatorGenerations.workspaceId, input.workspaceId),
      eq(creatorGenerations.creatorProjectId, input.creatorProjectId),
    )).limit(1).for("update");
    const [lockedAsset] = await tx.select().from(creatorAssets).where(scope).limit(1).for("update");
    const lockedIdentity = assertGeneratedAssetReviewTarget(lockedAsset, input);
    if (JSON.stringify(lockedIdentity) !== JSON.stringify(identity) ||
        lockedAsset!.storageKey !== asset!.storageKey || lockedAsset!.byteSize !== asset!.byteSize) {
      throw new Error("CREATOR_GENERATED_REVIEW_ARTIFACT_CHANGED");
    }
    assertGeneratedReviewGeneration(generation, lockedAsset!, lockedIdentity);
    const [latestJob] = await tx.select().from(creatorProviderJobs).where(and(
      eq(creatorProviderJobs.workspaceId, input.workspaceId),
      eq(creatorProviderJobs.creatorProjectId, input.creatorProjectId),
      eq(creatorProviderJobs.generationId, identity.generationId),
    )).orderBy(desc(creatorProviderJobs.id)).limit(1);
    assertGeneratedReviewProviderJob(latestJob, lockedAsset!, lockedIdentity);
    const [priorReview] = await tx.select({ id: creatorReviews.id }).from(creatorReviews).where(and(
      eq(creatorReviews.workspaceId, input.workspaceId),
      eq(creatorReviews.creatorProjectId, input.creatorProjectId),
      eq(creatorReviews.assetId, input.assetId),
      eq(creatorReviews.reviewType, "HUMAN_VISUAL"),
    )).limit(1);
    if (priorReview) throw new Error("CREATOR_GENERATED_REVIEW_ALREADY_DECIDED");

    await tx.update(creatorAssets).set({
      reviewDecision: input.decision === "APPROVE" ? "APPROVED" : "REJECTED",
    }).where(and(scope, eq(creatorAssets.reviewDecision, "PENDING")));
    const inserted = await tx.insert(creatorReviews).values({
      workspaceId: input.workspaceId,
      creatorProjectId: input.creatorProjectId,
      generationId: identity.generationId,
      shotId: lockedAsset!.shotId,
      assetId: input.assetId,
      reviewType: "HUMAN_VISUAL",
      decision: input.decision === "APPROVE" ? "PASS" : "REJECT",
      reviewerUserId: input.reviewerUserId,
      notes: input.notes.trim(),
      scoresJson: JSON.stringify({
        scope: "GENERATED_VISUAL_ASSET",
        checksumSha256: lockedAsset!.checksumSha256,
        storageVerified: input.decision === "APPROVE",
        providerJobId: identity.providerJobId,
      }),
    });
    return {
      assetId: input.assetId,
      reviewId: Number(inserted[0].insertId),
      reviewDecision: input.decision === "APPROVE" ? "APPROVED" as const : "REJECTED" as const,
      timelineEligible: input.decision === "APPROVE",
      finalMaster: false as const,
      publishApproved: false as const,
    };
  });
}
