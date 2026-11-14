import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { getWorkspaceForUser } from "../db";
import { protectedProcedure, router } from "../_core/trpc";
import { submitCreatorGeneration } from "./orchestrator";
import { createCreatorSpendHook, requireCreatorWorkspaceOwner, requirePaidCreatorAccess } from "./paidGeneration";
import { creatorError, requirePaidGenerationReady } from "./routerGuards";
import { resolveAvatarAudio } from "./speech/audioAsset";
import { reviewGeneratedSpeech } from "./speech/speechReview";
import { admitAvatarGenerationDispatch, findActiveConsent, listConsents, PROVIDER_SUBJECT_ID, recordConsent, revokeConsent } from "./speech/consentStore";

/**
 * Speech (TTS) and avatar-video generation for Creator, plus the consent records avatar video requires.
 * Same gate order as submitImage/submitVideo: switch → owner → kind-specific allowlist → spend policy → readiness →
 * server-side resolution → durable orchestrator (idempotency, spend hold, ambiguous-submission handling, artifacts).
 */
const workspaceInput = z.object({ workspaceId: z.number().int().positive() });
const generationTarget = workspaceInput.extend({
  creatorProjectId: z.number().int().positive(),
  shotId: z.number().int().positive(),
  idempotencyKey: z.string().uuid(),
});

export const creatorSpeechAvatarRouter = router({
  listConsents: protectedProcedure.input(workspaceInput).query(async ({ ctx, input }) => {
    if (!(await getWorkspaceForUser(ctx.user.id, input.workspaceId))) throw new TRPCError({ code: "FORBIDDEN", message: "Workspace access denied" });
    try { return await listConsents(input.workspaceId); } catch (error) { creatorError(error); }
  }),

  recordConsent: protectedProcedure
    .input(workspaceInput.extend({
      purpose: z.enum(["avatar_video", "custom_voice"]),
      provider: z.enum(["heygen-avatar", "sarvam-tts"]),
      providerSubjectId: z.string().regex(PROVIDER_SUBJECT_ID),
      /** A reference to the signed release / consent evidence held outside SakthiAI. Not the evidence itself. */
      evidenceReference: z.string().trim().min(8).max(500),
      validUntil: z.string().datetime().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      await requireCreatorWorkspaceOwner(ctx.user.id, input.workspaceId);
      try {
        return await recordConsent({ ...input, userId: ctx.user.id, validUntil: input.validUntil ? new Date(input.validUntil) : undefined });
      } catch (error) { creatorError(error); }
    }),

  revokeConsent: protectedProcedure
    .input(workspaceInput.extend({ consentId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      // Revocation reduces risk and spend, so it stays available while paid generation is switched off.
      await requireCreatorWorkspaceOwner(ctx.user.id, input.workspaceId);
      try { return await revokeConsent({ ...input, userId: ctx.user.id }); } catch (error) { creatorError(error); }
    }),

  /** Human listen-and-check of generated speech. PASS approves and locks it (it may then drive an avatar); final. */
  reviewSpeech: protectedProcedure
    .input(workspaceInput.extend({
      creatorProjectId: z.number().int().positive(),
      assetId: z.number().int().positive(),
      decision: z.enum(["PASS", "REJECT"]),
      notes: z.string().trim().min(1).max(5000),
    }))
    .mutation(async ({ ctx, input }) => {
      // Approval unlocks paid avatar use, so it is limited to the workspace owner (like submission).
      await requireCreatorWorkspaceOwner(ctx.user.id, input.workspaceId);
      try { return await reviewGeneratedSpeech({ ...input, reviewerUserId: ctx.user.id }); } catch (error) { creatorError(error); }
    }),

  submitSpeech: protectedProcedure
    .input(generationTarget.extend({
      /** Exact approved text; Tamil (ta-IN) or English (en-IN). Mixed Tamil/English text is sent as-is under ta-IN. */
      text: z.string().trim().min(1).max(10_000),
      languageCode: z.enum(["ta-IN", "en-IN"]).default("ta-IN"),
      model: z.enum(["bulbul:v2", "bulbul:v3", "bulbul:v4-flash"]).optional(),
      speaker: z.string().regex(/^[a-z0-9_]{2,64}$/).optional(),
      pace: z.number().min(0.3).max(3).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const paidConfig = await requirePaidCreatorAccess(ctx.user, input.workspaceId, "SPEECH");
      await requirePaidGenerationReady();
      try {
        return await submitCreatorGeneration({
          workspaceId: input.workspaceId,
          creatorProjectId: input.creatorProjectId,
          shotId: input.shotId,
          idempotencyKey: input.idempotencyKey,
          spend: createCreatorSpendHook({ user: ctx.user, workspaceId: input.workspaceId, idempotencyKey: input.idempotencyKey, config: paidConfig }),
          request: { kind: "SPEECH", prompt: input.text, model: input.model, languageCode: input.languageCode, speaker: input.speaker, pace: input.pace },
        });
      } catch (error) { creatorError(error); }
    }),

  submitAvatarVideo: protectedProcedure
    .input(generationTarget.extend({
      avatarId: z.string().regex(PROVIDER_SUBJECT_ID),
      consentId: z.number().int().positive(),
      audioAssetId: z.number().int().positive(),
      title: z.string().trim().min(1).max(120).default("SakthiAI avatar video"),
      /** HeyGen v3: no documented free preview; only explicit billed mode may proceed. */
      live: z.boolean().default(false),
    }))
    .mutation(async ({ ctx, input }) => {
      if (input.live !== true) throw new TRPCError({ code: "BAD_REQUEST", message: "AVATAR_V3_LIVE_APPROVAL_REQUIRED" });
      const paidConfig = await requirePaidCreatorAccess(ctx.user, input.workspaceId, "AVATAR_VIDEO");
      await requirePaidGenerationReady();
      try {
        // Consent before audio: an unconsented likeness never causes a storage read or a provider call.
        const consent = await findActiveConsent({ workspaceId: input.workspaceId, consentId: input.consentId, purpose: "avatar_video", provider: "heygen-avatar", providerSubjectId: input.avatarId });
        const audio = await resolveAvatarAudio({ workspaceId: input.workspaceId, creatorProjectId: input.creatorProjectId, assetId: input.audioAssetId });
        return await submitCreatorGeneration({
          workspaceId: input.workspaceId,
          creatorProjectId: input.creatorProjectId,
          shotId: input.shotId,
          idempotencyKey: input.idempotencyKey,
          spend: createCreatorSpendHook({ user: ctx.user, workspaceId: input.workspaceId, idempotencyKey: input.idempotencyKey, config: paidConfig }),
          request: {
            kind: "AVATAR_VIDEO",
            prompt: input.title,
            avatarId: input.avatarId,
            consentId: consent.id,
            audioAssetId: audio.assetId,
            expectedSeconds: audio.durationMs / 1000,
            audio: { mimeType: audio.mimeType, data: audio.data },
            callbackId: input.idempotencyKey,
            live: input.live,
          },
          beforeProviderSubmit: async (generationId) => {
            await admitAvatarGenerationDispatch({ workspaceId: input.workspaceId, consentId: input.consentId, purpose: "avatar_video", provider: "heygen-avatar", providerSubjectId: input.avatarId, generationId, callbackId: input.idempotencyKey });
          },
        });
      } catch (error) { creatorError(error); }
    }),
});
