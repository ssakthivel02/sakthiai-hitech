import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import { getWorkspaceForUser } from "../db";
import { ingestApprovedReference, updateCreatorShotTiming } from "./referenceLibrary";
import { TRPCError } from "@trpc/server";

const base = z.object({
  workspaceId: z.number().int().positive(),
  creatorProjectId: z.number().int().positive(),
});

async function requireWorkspace(userId: number, workspaceId: number) {
  const workspace = await getWorkspaceForUser(userId, workspaceId);
  if (!workspace) throw new TRPCError({ code: "FORBIDDEN", message: "Workspace access denied" });
}

function boundedCreatorError(error: unknown): never {
  const message = error instanceof Error ? error.message : "CREATOR_REFERENCE_RUNTIME_ERROR";
  if (message === "CREATOR_DATABASE_UNAVAILABLE" || message.startsWith("Storage config missing")) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message });
  }
  if (message.startsWith("CREATOR_")) throw new TRPCError({ code: "BAD_REQUEST", message });
  throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "CREATOR_REFERENCE_RUNTIME_ERROR" });
}

export const creatorReferenceRouter = router({
  ingestApproved: protectedProcedure.input(base.extend({
    filename: z.string().trim().min(1).max(180),
    mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
    dataBase64: z.string().min(1).max(30_000_000),
    kind: z.enum(["CHARACTER", "STYLE", "LOCATION", "OBJECT"]),
    label: z.string().trim().min(1).max(180),
    approved: z.literal(true),
  })).mutation(async ({ ctx, input }) => {
    await requireWorkspace(ctx.user.id, input.workspaceId);
    try {
      return await ingestApprovedReference({
        workspaceId: input.workspaceId,
        creatorProjectId: input.creatorProjectId,
        filename: input.filename,
        mimeType: input.mimeType,
        data: Buffer.from(input.dataBase64, "base64"),
        kind: input.kind,
        label: input.label,
        approvedByUserId: ctx.user.id,
      });
    } catch (error) {
      boundedCreatorError(error);
    }
  }),

  updateShotTiming: protectedProcedure.input(base.extend({
    shotId: z.number().int().positive(),
    startMs: z.number().int().min(0),
    endMs: z.number().int().positive(),
  })).mutation(async ({ ctx, input }) => {
    await requireWorkspace(ctx.user.id, input.workspaceId);
    try {
      return await updateCreatorShotTiming(input);
    } catch (error) {
      boundedCreatorError(error);
    }
  }),
});
