import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { getWorkspaceForUser } from "../db";
import { protectedProcedure, router } from "../_core/trpc";
import { googleVeoStatus, pollGoogleVeo, submitGoogleVeo } from "./googleVeo";

const imageInput = z.object({
  mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
  dataBase64: z.string().min(1).max(12_000_000),
});

const workspaceInput = z.object({ workspaceId: z.number().int().positive() });

async function requireWorkspace(userId: number, workspaceId: number) {
  const workspace = await getWorkspaceForUser(userId, workspaceId);
  if (!workspace) throw new TRPCError({ code: "FORBIDDEN", message: "Workspace access denied" });
  return workspace;
}

function creatorError(error: unknown): never {
  const message = error instanceof Error ? error.message : "CREATOR_PROVIDER_ERROR";
  if (message === "GOOGLE_VEO_NOT_CONFIGURED") {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message });
  }
  if (message.startsWith("CREATOR_")) {
    throw new TRPCError({ code: "BAD_REQUEST", message });
  }
  throw new TRPCError({ code: "BAD_GATEWAY", message: "CREATOR_PROVIDER_REQUEST_FAILED" });
}

export const creatorRouter = router({
  status: protectedProcedure.input(workspaceInput).query(async ({ ctx, input }) => {
    await requireWorkspace(ctx.user.id, input.workspaceId);
    return {
      stage: "P0_VIDEO_ADAPTER" as const,
      productionApproved: false,
      provider: googleVeoStatus(),
      nextRequired: [
        "persist async generation jobs",
        "download completed outputs into SakthiAI-controlled object storage",
        "bind generated assets to project/shot/reference IDs",
        "connect audio-driven timeline, captions, assembly/render and quality gate",
      ],
    };
  }),

  submitVideo: protectedProcedure
    .input(
      workspaceInput.extend({
        prompt: z.string().trim().min(1).max(8000),
        model: z
          .enum([
            "veo-3.1-generate-preview",
            "veo-3.1-fast-generate-preview",
            "veo-3.1-lite-generate-preview",
          ])
          .optional(),
        aspectRatio: z.enum(["16:9", "9:16"]).default("16:9"),
        resolution: z.enum(["720p", "1080p", "4k"]).default("720p"),
        durationSeconds: z.union([z.literal(4), z.literal(6), z.literal(8)]).default(8),
        firstFrame: imageInput.optional(),
        lastFrame: imageInput.optional(),
        referenceImages: z.array(imageInput).max(3).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireWorkspace(ctx.user.id, input.workspaceId);
      try {
        const operation = await submitGoogleVeo(input);
        return {
          provider: "google-veo" as const,
          operationName: operation.name,
          done: Boolean(operation.done),
          submittedAt: new Date().toISOString(),
          persisted: false,
          productionApproved: false,
        };
      } catch (error) {
        creatorError(error);
      }
    }),

  pollVideo: protectedProcedure
    .input(workspaceInput.extend({ operationName: z.string().min(1).max(512) }))
    .query(async ({ ctx, input }) => {
      await requireWorkspace(ctx.user.id, input.workspaceId);
      try {
        const operation = await pollGoogleVeo(input.operationName);
        return {
          provider: "google-veo" as const,
          operationName: operation.name || input.operationName,
          done: Boolean(operation.done),
          response: operation.response ?? null,
          error: operation.error ?? null,
          persisted: false,
          productionApproved: false,
        };
      } catch (error) {
        creatorError(error);
      }
    }),
});
