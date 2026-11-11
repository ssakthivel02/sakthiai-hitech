import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import { requireCreatorWorkspaceOwner } from "./paidGeneration";
import { reviewCreatorGeneratedAsset } from "./generatedAssetReview";
import {
  finalizeCreatorMaster,
  recordCreatorHumanReview,
  recordCreatorQualityReview,
} from "./reviewService";

const workspaceProjectAsset = z.object({
  workspaceId: z.number().int().positive(),
  creatorProjectId: z.number().int().positive(),
  assetId: z.number().int().positive(),
});

const dimensionIds = [
  "VQ-CONTENT-01",
  "VQ-TEMPORAL-01",
  "VQ-IDENTITY-01",
  "VQ-VISUAL-01",
  "VQ-CAMERA-01",
  "VQ-AUDIO-01",
  "VQ-TEXT-01",
  "VQ-DELIVERY-01",
] as const;

const dimensionScores = z.object(Object.fromEntries(
  dimensionIds.map(id => [id, z.number().min(0).max(5)]),
) as Record<(typeof dimensionIds)[number], z.ZodNumber>);

/**
 * Every procedure in this router records a consequential decision on a 16:9 master: a quality verdict (which can
 * reject the asset), a final human Tamil/visual PASS or REJECT, or promotion to final master. They are workspace-owner
 * only, matching speech approval and 9:16 crop approval. Ordinary members keep read access through the workspace
 * router (getProject). Checked before any database read or write.
 */

function creatorReviewError(error: unknown): never {
  const message = error instanceof Error ? error.message : "CREATOR_REVIEW_RUNTIME_ERROR";
  if (message === "CREATOR_DATABASE_UNAVAILABLE") throw new TRPCError({ code: "PRECONDITION_FAILED", message });
  if (message.startsWith("CREATOR_")) throw new TRPCError({ code: "BAD_REQUEST", message });
  throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "CREATOR_REVIEW_RUNTIME_ERROR" });
}

export const creatorReviewRouter = router({
  /** Review a completed, immutable generated IMAGE/VIDEO before it can enter a timeline.
   * No generation submission, publishing or master promotion occurs here.
   */
  reviewGeneratedAsset: protectedProcedure.input(workspaceProjectAsset.extend({
    expectedChecksumSha256: z.string().regex(/^[a-f0-9]{64}$/),
    decision: z.enum(["APPROVE", "REJECT"]),
    notes: z.string().trim().min(8).max(5000),
    confirmAssetReviewed: z.literal(true),
  })).mutation(async ({ ctx, input }) => {
    await requireCreatorWorkspaceOwner(ctx.user.id, input.workspaceId);
    try {
      return await reviewCreatorGeneratedAsset({ ...input, reviewerUserId: ctx.user.id });
    } catch (error) {
      creatorReviewError(error);
    }
  }),

  quality: protectedProcedure.input(workspaceProjectAsset.extend({
    reviewerType: z.enum(["HUMAN", "ASSISTED_HUMAN"]),
    sourcePromptOrStoryboard: z.string().trim().min(1).max(20_000),
    dimensionScores,
    criticalDefects: z.array(z.string().trim().min(1).max(1000)).max(50).default([]),
    notes: z.string().trim().max(5000).optional(),
  })).mutation(async ({ ctx, input }) => {
    await requireCreatorWorkspaceOwner(ctx.user.id, input.workspaceId);
    try {
      return await recordCreatorQualityReview({ ...input, reviewerUserId: ctx.user.id });
    } catch (error) {
      creatorReviewError(error);
    }
  }),

  humanTamil: protectedProcedure.input(workspaceProjectAsset.extend({
    decision: z.enum(["PASS", "REJECT"]),
    notes: z.string().trim().min(1).max(5000),
  })).mutation(async ({ ctx, input }) => {
    await requireCreatorWorkspaceOwner(ctx.user.id, input.workspaceId);
    try {
      return await recordCreatorHumanReview({ ...input, reviewerUserId: ctx.user.id, reviewType: "HUMAN_TAMIL" });
    } catch (error) {
      creatorReviewError(error);
    }
  }),

  humanVisual: protectedProcedure.input(workspaceProjectAsset.extend({
    decision: z.enum(["PASS", "REJECT"]),
    notes: z.string().trim().min(1).max(5000),
  })).mutation(async ({ ctx, input }) => {
    await requireCreatorWorkspaceOwner(ctx.user.id, input.workspaceId);
    try {
      return await recordCreatorHumanReview({ ...input, reviewerUserId: ctx.user.id, reviewType: "HUMAN_VISUAL" });
    } catch (error) {
      creatorReviewError(error);
    }
  }),

  finalizeMaster: protectedProcedure.input(workspaceProjectAsset).mutation(async ({ ctx, input }) => {
    await requireCreatorWorkspaceOwner(ctx.user.id, input.workspaceId);
    try {
      return await finalizeCreatorMaster(input);
    } catch (error) {
      creatorReviewError(error);
    }
  }),
});
