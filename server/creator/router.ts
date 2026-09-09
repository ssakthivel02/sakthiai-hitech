import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { getWorkspaceForUser } from "../db";
import { protectedProcedure, router } from "../_core/trpc";
import { googleVeoStatus, pollGoogleVeo, submitGoogleVeo } from "./googleVeo";
import {
  createQueuedVideoGeneration,
  markGenerationFailed,
  recordProviderPoll,
  recordProviderSubmission,
} from "./persistence";

const imageInput = z.object({
  mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
  dataBase64: z.string().min(1).max(12_000_000),
  assetId: z.number().int().positive().optional(),
});

const workspaceInput = z.object({ workspaceId: z.number().int().positive() });

async function requireWorkspace(userId: number, workspaceId: number) {
  const workspace = await getWorkspaceForUser(userId, workspaceId);
  if (!workspace) throw new TRPCError({ code: "FORBIDDEN", message: "Workspace access denied" });
  return workspace;
}

function failureMessage(error: unknown) {
  return error instanceof Error ? error.message : "CREATOR_PROVIDER_ERROR";
}

function creatorError(error: unknown): never {
  const message = failureMessage(error);
  if (message === "GOOGLE_VEO_NOT_CONFIGURED" || message === "CREATOR_DATABASE_UNAVAILABLE") {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message });
  }
  if (message.startsWith("CREATOR_")) {
    throw new TRPCError({ code: "BAD_REQUEST", message });
  }
  throw new TRPCError({ code: "BAD_GATEWAY", message: "CREATOR_PROVIDER_REQUEST_FAILED" });
}

function operationState(done?: boolean, error?: unknown) {
  if (error) return "FAILED" as const;
  return done ? "SUCCEEDED" as const : "RUNNING" as const;
}

export const creatorRouter = router({
  status: protectedProcedure.input(workspaceInput).query(async ({ ctx, input }) => {
    await requireWorkspace(ctx.user.id, input.workspaceId);
    return {
      stage: "P0_ASYNC_JOB_PERSISTENCE" as const,
      productionApproved: false,
      provider: googleVeoStatus(),
      nextRequired: [
        "download completed outputs into SakthiAI-controlled object storage",
        "persist generated artifact checksum/provenance and bind it to the shot",
        "connect audio-driven timeline and Tamil caption cues",
        "connect deterministic assembly/render and existing quality gate",
      ],
    };
  }),

  submitVideo: protectedProcedure
    .input(
      workspaceInput.extend({
        creatorProjectId: z.number().int().positive(),
        shotId: z.number().int().positive(),
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
      const provider = googleVeoStatus();
      const model = input.model ?? provider.defaultModel;
      const sourceAssetIds = [
        input.firstFrame?.assetId,
        input.lastFrame?.assetId,
        ...(input.referenceImages ?? []).map(image => image.assetId),
      ].filter((id): id is number => Boolean(id));

      const generationId = await createQueuedVideoGeneration({
        workspaceId: input.workspaceId,
        creatorProjectId: input.creatorProjectId,
        shotId: input.shotId,
        provider: "google-veo",
        model,
        parameters: {
          prompt: input.prompt,
          aspectRatio: input.aspectRatio,
          resolution: input.resolution,
          durationSeconds: input.durationSeconds,
          hasFirstFrame: Boolean(input.firstFrame),
          hasLastFrame: Boolean(input.lastFrame),
          referenceCount: input.referenceImages?.length ?? 0,
        },
        sourceAssetIds,
      });

      try {
        const operation = await submitGoogleVeo(input);
        const state = operation.done ? "SUCCEEDED" as const : "SUBMITTED" as const;
        await recordProviderSubmission({
          workspaceId: input.workspaceId,
          creatorProjectId: input.creatorProjectId,
          generationId,
          submission: {
            providerJobId: operation.name,
            state,
            provider: "google-veo",
            model,
            raw: operation,
          },
        });
        return {
          generationId,
          provider: "google-veo" as const,
          operationName: operation.name,
          done: Boolean(operation.done),
          submittedAt: new Date().toISOString(),
          persisted: true,
          productionApproved: false,
        };
      } catch (error) {
        await markGenerationFailed({
          workspaceId: input.workspaceId,
          creatorProjectId: input.creatorProjectId,
          generationId,
          failureClass: "UNKNOWN",
          errorMessage: failureMessage(error),
        }).catch(() => undefined);
        creatorError(error);
      }
    }),

  pollVideo: protectedProcedure
    .input(workspaceInput.extend({ operationName: z.string().min(1).max(512) }))
    .query(async ({ ctx, input }) => {
      await requireWorkspace(ctx.user.id, input.workspaceId);
      try {
        const operation = await pollGoogleVeo(input.operationName);
        const state = operationState(operation.done, operation.error);
        const persisted = await recordProviderPoll({
          workspaceId: input.workspaceId,
          providerJobId: input.operationName,
          poll: {
            providerJobId: operation.name || input.operationName,
            state,
            raw: operation,
            artifacts: [],
            failureClass: operation.error ? "UNKNOWN" : undefined,
            errorMessage: operation.error ? JSON.stringify(operation.error).slice(0, 2000) : undefined,
          },
        });
        return {
          generationId: persisted.generationId,
          creatorProjectId: persisted.creatorProjectId,
          provider: "google-veo" as const,
          operationName: operation.name || input.operationName,
          done: Boolean(operation.done),
          response: operation.response ?? null,
          error: operation.error ?? null,
          persisted: true,
          productionApproved: false,
        };
      } catch (error) {
        creatorError(error);
      }
    }),
});
