import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import { getDb, getWorkspaceForUser, searchChunks } from "../db";
import { isLowInformationQuery } from "../retrieval";
import { ArtifactError, createArtifactFromMessage, getArtifact, listArtifacts, searchArtifacts, type ArtifactErrorCode } from "./store";
import { groupDocumentHits } from "./workspaceSearch";

const workspaceInput = z.object({ workspaceId: z.number().int().positive() });

/** Same authorization rule as every other workspace router: membership is checked before any data access. */
async function requireWorkspace(userId: number, workspaceId: number) {
  const workspace = await getWorkspaceForUser(userId, workspaceId);
  if (!workspace) throw new TRPCError({ code: "FORBIDDEN", message: "Workspace access denied" });
  return workspace;
}
async function requireDb() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  return db;
}
const errorCode = { CONVERSATION_DENIED: "FORBIDDEN", PROJECT_DENIED: "FORBIDDEN", MESSAGE_NOT_FOUND: "NOT_FOUND", NOT_FOUND: "NOT_FOUND", NOT_SAVEABLE: "PRECONDITION_FAILED", TOO_LARGE: "PAYLOAD_TOO_LARGE" } as const satisfies Record<ArtifactErrorCode, TRPCError["code"]>;
async function guard<T>(run: () => Promise<T>): Promise<T> {
  try { return await run(); } catch (error) { if (error instanceof ArtifactError) throw new TRPCError({ code: errorCode[error.code], message: error.message }); throw error; }
}

export const artifactsRouter = router({
  /** Saves a grounded assistant answer (content + citations read server-side from the stored message). Idempotent per message. */
  saveFromMessage: protectedProcedure
    .input(workspaceInput.extend({ conversationId: z.number().int().positive(), messageId: z.number().int().positive(), projectId: z.number().int().positive().optional(), title: z.string().max(400).optional() }))
    .mutation(async ({ ctx, input }) => {
      await requireWorkspace(ctx.user.id, input.workspaceId);
      const db = await requireDb();
      return guard(() => createArtifactFromMessage(db, { workspaceId: input.workspaceId, userId: ctx.user.id, conversationId: input.conversationId, messageId: input.messageId, projectId: input.projectId, title: input.title }));
    }),
  list: protectedProcedure
    .input(workspaceInput.extend({ projectId: z.number().int().positive().optional(), limit: z.number().int().min(1).max(200).optional() }))
    .query(async ({ ctx, input }) => {
      await requireWorkspace(ctx.user.id, input.workspaceId);
      return listArtifacts(await requireDb(), input.workspaceId, { projectId: input.projectId, limit: input.limit });
    }),
  get: protectedProcedure
    .input(workspaceInput.extend({ artifactId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      await requireWorkspace(ctx.user.id, input.workspaceId);
      const artifact = await getArtifact(await requireDb(), input.workspaceId, input.artifactId);
      if (!artifact) throw new TRPCError({ code: "NOT_FOUND", message: "Artifact not found" });
      return artifact;
    }),
});

export const workspaceSearchRouter = router({
  /** Universal (workspace-scoped) search: saved artifacts and uploaded files, as two separately ranked groups. */
  workspace: protectedProcedure
    .input(workspaceInput.extend({ query: z.string().trim().min(1).max(500), limit: z.number().int().min(1).max(25).optional() }))
    .query(async ({ ctx, input }) => {
      await requireWorkspace(ctx.user.id, input.workspaceId);
      const db = await requireDb();
      const limit = input.limit ?? 10;
      const [artifactHits, chunkHits] = await Promise.all([searchArtifacts(db, input.workspaceId, input.query, limit), searchChunks(input.workspaceId, input.query)]);
      return {
        query: input.query,
        lowInformation: isLowInformationQuery(input.query),
        artifacts: artifactHits,
        documents: groupDocumentHits(chunkHits, limit),
      };
    }),
});
