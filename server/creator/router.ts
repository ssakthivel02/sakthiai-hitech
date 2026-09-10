import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { getWorkspaceForUser } from "../db";
import { protectedProcedure, router } from "../_core/trpc";
import { creatorAudioRouter } from "./audioRouter";
import { creatorReviewRouter } from "./reviewRouter";
import { creatorTimelineRouter } from "./timelineRouter";
import { creatorWorkspaceRouter } from "./workspaceRouter";
import {
  cancelCreatorGeneration,
  pollCreatorGeneration,
  retryCreatorGeneration,
  submitCreatorGeneration,
} from "./orchestrator";
import { listCreatorProviderStatuses } from "./providerRegistry";
import { buildCreatorRuntimePreflight } from "./runtimePreflight";

const imageInput = z.object({
  mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
  dataBase64: z.string().min(1).max(12_000_000),
  assetId: z.number().int().positive().optional(),
});

const workspaceInput = z.object({ workspaceId: z.number().int().positive() });
const generationInput = workspaceInput.extend({ generationId: z.number().int().positive() });

async function requireWorkspace(userId: number, workspaceId: number) {
  const workspace = await getWorkspaceForUser(userId, workspaceId);
  if (!workspace) throw new TRPCError({ code: "FORBIDDEN", message: "Workspace access denied" });
  return workspace;
}

function creatorError(error: unknown): never {
  const message = error instanceof Error ? error.message : "CREATOR_RUNTIME_ERROR";
  if (
    message.includes("NOT_CONFIGURED") ||
    message === "CREATOR_DATABASE_UNAVAILABLE" ||
    message.startsWith("Storage config missing")
  ) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message });
  }
  if (message.startsWith("CREATOR_")) {
    throw new TRPCError({ code: "BAD_REQUEST", message });
  }
  throw new TRPCError({ code: "BAD_GATEWAY", message: "CREATOR_PROVIDER_REQUEST_FAILED" });
}

export const creatorRouter = router({
  workspace: creatorWorkspaceRouter,
  audio: creatorAudioRouter,
  timeline: creatorTimelineRouter,
  review: creatorReviewRouter,

  status: protectedProcedure.input(workspaceInput).query(async ({ ctx, input }) => {
    await requireWorkspace(ctx.user.id, input.workspaceId);
    return {
      stage: "P0_CREATOR_WORKSPACE_UI_RUNTIME" as const,
      productionApproved: false,
      providers: listCreatorProviderStatuses(),
      guarantees: {
        durableGenerationId: true,
        providerNeutralControlHandle: true,
        artifactRequiredBeforeSuccess: true,
        checksumAndProvenanceOnPersist: true,
        retryReusesExistingProviderJob: true,
        cancellationRequiresRemoteProviderAcknowledgement: true,
        immutableApprovedAudioMaster: true,
        captionBoundsDerivedFromAudioMaster: true,
        approvedVisualTimelineCoverageRequired: true,
        deterministicFfmpegCandidateRender: true,
        renderChecksumAndProvenance: true,
        governedVideoQualitySpecId: "SAI-VIDEO-QUALITY",
        outputConformanceBeforeQualityScoring: true,
        providerNeutralRemediation: true,
        qualityPassRequiredBeforeFinalMaster: true,
        humanTamilReviewRequired: true,
        humanVisualReviewRequiredBeforeFinalMaster: true,
        finalMasterPromotionDoesNotPublish: true,
        automaticPublish: false,
      },
      nextRequired: [
        "apply Creator database migration to an approved runtime",
        "configure approved provider credential and S3-compatible storage outside Git",
        "verify Creator runtime preflight before any paid generation",
        "run one real Murugan image generation and one real Murugan video generation",
        "run the complete Murugan 16:9 acceptance sequence with real output and human Tamil/visual evidence",
      ],
    };
  }),

  preflight: protectedProcedure.input(workspaceInput).query(async ({ ctx, input }) => {
    await requireWorkspace(ctx.user.id, input.workspaceId);
    return buildCreatorRuntimePreflight();
  }),

  submitImage: protectedProcedure
    .input(
      workspaceInput.extend({
        creatorProjectId: z.number().int().positive(),
        shotId: z.number().int().positive(),
        kind: z.enum(["IMAGE", "IMAGE_EDIT"]).default("IMAGE"),
        prompt: z.string().trim().min(1).max(8000),
        model: z.literal("gemini-3.1-flash-image").optional(),
        aspectRatio: z.enum(["1:1", "9:16", "16:9"]).default("16:9"),
        imageSize: z.enum(["1K", "2K", "4K"]).default("2K"),
        references: z.array(imageInput).max(4).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireWorkspace(ctx.user.id, input.workspaceId);
      try {
        return await submitCreatorGeneration({
          workspaceId: input.workspaceId,
          creatorProjectId: input.creatorProjectId,
          shotId: input.shotId,
          request: {
            kind: input.kind,
            prompt: input.prompt,
            model: input.model,
            aspectRatio: input.aspectRatio,
            imageSize: input.imageSize,
            references: input.references,
          },
        });
      } catch (error) {
        creatorError(error);
      }
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
      try {
        return await submitCreatorGeneration({
          workspaceId: input.workspaceId,
          creatorProjectId: input.creatorProjectId,
          shotId: input.shotId,
          request: {
            kind: "VIDEO",
            prompt: input.prompt,
            model: input.model,
            aspectRatio: input.aspectRatio,
            resolution: input.resolution,
            durationSeconds: input.durationSeconds,
            firstFrame: input.firstFrame,
            lastFrame: input.lastFrame,
            references: input.referenceImages,
          },
        });
      } catch (error) {
        creatorError(error);
      }
    }),

  pollGeneration: protectedProcedure.input(generationInput).query(async ({ ctx, input }) => {
    await requireWorkspace(ctx.user.id, input.workspaceId);
    try {
      return await pollCreatorGeneration(input);
    } catch (error) {
      creatorError(error);
    }
  }),

  retryGeneration: protectedProcedure.input(generationInput).mutation(async ({ ctx, input }) => {
    await requireWorkspace(ctx.user.id, input.workspaceId);
    try {
      return await retryCreatorGeneration(input);
    } catch (error) {
      creatorError(error);
    }
  }),

  cancelGeneration: protectedProcedure.input(generationInput).mutation(async ({ ctx, input }) => {
    await requireWorkspace(ctx.user.id, input.workspaceId);
    try {
      return await cancelCreatorGeneration(input);
    } catch (error) {
      creatorError(error);
    }
  }),
});
