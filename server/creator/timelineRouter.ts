import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { getWorkspaceForUser } from "../db";
import { protectedProcedure, router } from "../_core/trpc";
import { executeCreatorTimelineExport } from "./renderService";
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
});
