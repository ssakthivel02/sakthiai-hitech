import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { getWorkspaceForUser } from "../db";
import { protectedProcedure, router } from "../_core/trpc";
import { ingestApprovedAudioMaster, replaceLockedCaptionCues } from "./audioMaster";

const workspaceInput = z.object({ workspaceId: z.number().int().positive() });
const cueInput = z.object({
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().positive(),
  text: z.string().max(600),
  language: z.enum(["ta", "en"]).default("ta"),
});

async function requireWorkspace(userId: number, workspaceId: number) {
  const workspace = await getWorkspaceForUser(userId, workspaceId);
  if (!workspace) throw new TRPCError({ code: "FORBIDDEN", message: "Workspace access denied" });
}

function mapCreatorAudioError(error: unknown): never {
  const message = error instanceof Error ? error.message : "CREATOR_AUDIO_RUNTIME_ERROR";
  if (message === "CREATOR_DATABASE_UNAVAILABLE" || message.startsWith("Storage config missing")) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message });
  }
  if (message === "CREATOR_PROJECT_NOT_FOUND" || message === "CREATOR_TIMELINE_NOT_FOUND") {
    throw new TRPCError({ code: "NOT_FOUND", message });
  }
  if (message === "CREATOR_AUDIO_MASTER_ALREADY_LOCKED" || message === "CREATOR_AUDIO_DUPLICATE") {
    throw new TRPCError({ code: "CONFLICT", message });
  }
  if (message.startsWith("CREATOR_")) throw new TRPCError({ code: "BAD_REQUEST", message });
  throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "CREATOR_AUDIO_RUNTIME_ERROR" });
}

export const creatorAudioRouter = router({
  ingestApprovedMaster: protectedProcedure
    .input(
      workspaceInput.extend({
        creatorProjectId: z.number().int().positive(),
        filename: z.string().min(1).max(255),
        mimeType: z.enum(["audio/wav", "audio/x-wav"]),
        dataBase64: z.string().min(1).max(350_000_000),
        approved: z.literal(true),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireWorkspace(ctx.user.id, input.workspaceId);
      try {
        const data = Buffer.from(input.dataBase64.replace(/^data:[^;]+;base64,/, ""), "base64");
        return await ingestApprovedAudioMaster({
          workspaceId: input.workspaceId,
          creatorProjectId: input.creatorProjectId,
          filename: input.filename,
          mimeType: input.mimeType,
          data,
          approvedByUserId: ctx.user.id,
        });
      } catch (error) {
        mapCreatorAudioError(error);
      }
    }),

  replaceCaptionCues: protectedProcedure
    .input(
      workspaceInput.extend({
        creatorProjectId: z.number().int().positive(),
        timelineId: z.number().int().positive(),
        cues: z.array(cueInput).max(5000),
        humanTamilReviewed: z.literal(true),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireWorkspace(ctx.user.id, input.workspaceId);
      try {
        return await replaceLockedCaptionCues({
          workspaceId: input.workspaceId,
          creatorProjectId: input.creatorProjectId,
          timelineId: input.timelineId,
          cues: input.cues,
        });
      } catch (error) {
        mapCreatorAudioError(error);
      }
    }),
});
