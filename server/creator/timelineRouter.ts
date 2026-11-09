import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { getWorkspaceForUser } from "../db";
import { protectedProcedure, router } from "../_core/trpc";
import { executeCreatorTimelineExport } from "./renderService";
import { dispatchReservedCreatorRender } from "./renderDispatch";
import { CREATOR_CAPTION_FONT_FAMILY } from "./renderWorker";
import { getCreatorExportManifest } from "./exportManifest";
import { reviewVerticalDerivative } from "./derivativeReview";
import { requireCreatorWorkspaceOwner } from "./paidGeneration";
import { replaceApprovedTimelineItems } from "./timeline";

const workspaceInput = z.object({ workspaceId: z.number().int().positive() });
const timelineItemInput = z.object({
  assetId: z.number().int().positive(),
  shotId: z.number().int().positive().optional(),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().positive(),
  track: z.literal(1).default(1),
  sortOrder: z.number().int().nonnegative().optional(),
});

async function requireWorkspace(userId: number, workspaceId: number) {
  const workspace = await getWorkspaceForUser(userId, workspaceId);
  if (!workspace) throw new TRPCError({ code: "FORBIDDEN", message: "Workspace access denied" });
}

function mapTimelineError(error: unknown): never {
  const message = error instanceof Error ? error.message : "CREATOR_TIMELINE_RUNTIME_ERROR";
  if (message === "CREATOR_DATABASE_UNAVAILABLE" || message.startsWith("Storage config missing") || message.includes("FFMPEG_SPAWN_FAILED")) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message });
  }
  if (message.endsWith("NOT_FOUND")) throw new TRPCError({ code: "NOT_FOUND", message });
  if (message.startsWith("CREATOR_")) throw new TRPCError({ code: "BAD_REQUEST", message });
  throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "CREATOR_TIMELINE_RUNTIME_ERROR" });
}

export const creatorTimelineRouter = router({
  replaceApprovedItems: protectedProcedure
    .input(workspaceInput.extend({
      creatorProjectId: z.number().int().positive(),
      timelineId: z.number().int().positive(),
      items: z.array(timelineItemInput).min(1).max(5000),
    }))
    .mutation(async ({ ctx, input }) => {
      await requireWorkspace(ctx.user.id, input.workspaceId);
      try {
        return await replaceApprovedTimelineItems(input);
      } catch (error) {
        mapTimelineError(error);
      }
    }),


  /**
   * Explicit, owner-only P0 acceptance lane. OFF by default, even for owners.
   * This synchronous HTTP entry point is NOT a production queue or publishing API.
   * Never accepts caller-owned checksums, renderer settings, URLs or a lease token.
   */
  renderFencedCandidate: protectedProcedure
    .input(workspaceInput.extend({
      creatorProjectId: z.number().int().positive(),
      timelineId: z.number().int().positive(),
      confirmCandidateOnly: z.literal(true),
    }))
    .mutation(async ({ ctx, input }) => {
      await requireCreatorWorkspaceOwner(ctx.user.id, input.workspaceId);
      if (process.env.CREATOR_FENCED_RENDER_ENABLED !== "true") {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "CREATOR_FENCED_RENDER_DISABLED" });
      }
      try {
        const result = await dispatchReservedCreatorRender({
          workspaceId: input.workspaceId,
          creatorProjectId: input.creatorProjectId,
          timelineId: input.timelineId,
        }, {
          rendererVersion: "ffmpeg-v1",
          fontFamily: CREATOR_CAPTION_FONT_FAMILY,
        });
        if (!result.dispatched) {
          return {
            dispatched: false as const,
            claimId: result.claimId,
            exportId: result.exportId,
            state: result.state,
            finalMaster: false as const,
            publishApproved: false as const,
            nextGate: "EXISTING_RENDER_CLAIM" as const,
          };
        }
        return {
          dispatched: true as const,
          claimId: result.claimId,
          exportId: result.exportId,
          assetId: result.assetId,
          reviewDecision: "PENDING" as const,
          finalMaster: false as const,
          publishApproved: false as const,
          nextGate: "VIDEO_QUALITY_AND_HUMAN_REVIEW" as const,
        };
      } catch (error) {
        mapTimelineError(error);
      }
    }),

  renderCandidate: protectedProcedure
    .input(workspaceInput.extend({
      creatorProjectId: z.number().int().positive(),
      timelineId: z.number().int().positive(),
      confirmCandidateOnly: z.literal(true),
    }))
    .mutation(async ({ ctx, input }) => {
      await requireWorkspace(ctx.user.id, input.workspaceId);
      try {
        const result = await executeCreatorTimelineExport({
          workspaceId: input.workspaceId,
          creatorProjectId: input.creatorProjectId,
          timelineId: input.timelineId,
        });
        return {
          ...result,
          finalMaster: false as const,
          publishApproved: false as const,
          nextGate: "VIDEO_QUALITY_AND_HUMAN_REVIEW" as const,
        };
      } catch (error) {
        mapTimelineError(error);
      }
    }),

  /** 9:16 (1080×1920, centre-crop) delivery derivative of an APPROVED 16:9 final master; refuses on any source drift. */
  renderVerticalDerivative: protectedProcedure
    .input(workspaceInput.extend({
      creatorProjectId: z.number().int().positive(),
      timelineId: z.number().int().positive(),
      finalMasterAssetId: z.number().int().positive(),
    }))
    .mutation(async ({ ctx, input }) => {
      await requireWorkspace(ctx.user.id, input.workspaceId);
      try {
        const result = await executeCreatorTimelineExport({
          workspaceId: input.workspaceId,
          creatorProjectId: input.creatorProjectId,
          timelineId: input.timelineId,
          verticalDerivativeOf: input.finalMasterAssetId,
        });
        return { ...result, aspectRatio: "9:16" as const, derivative: true as const, finalMaster: false as const, publishApproved: false as const, humanCropCheckRequired: true as const };
      } catch (error) {
        mapTimelineError(error);
      }
    }),

  /**
   * Human check of a 9:16 derivative's crop. PASS approves it for delivery; it never becomes a master.
   * Owner-only, like speech approval: the decision is final and changes what may be delivered, so membership is not
   * enough. Checked before any database read or write.
   */
  reviewVerticalDerivative: protectedProcedure
    .input(workspaceInput.extend({
      creatorProjectId: z.number().int().positive(),
      assetId: z.number().int().positive(),
      decision: z.enum(["PASS", "REJECT"]),
      notes: z.string().trim().min(1).max(5000),
    }))
    .mutation(async ({ ctx, input }) => {
      await requireCreatorWorkspaceOwner(ctx.user.id, input.workspaceId);
      try {
        return await reviewVerticalDerivative({ ...input, reviewerUserId: ctx.user.id });
      } catch (error) {
        mapTimelineError(error);
      }
    }),

  exportManifest: protectedProcedure
    .input(workspaceInput.extend({ creatorProjectId: z.number().int().positive(), exportId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      await requireWorkspace(ctx.user.id, input.workspaceId);
      try {
        return await getCreatorExportManifest(input);
      } catch (error) {
        mapTimelineError(error);
      }
    }),
});
