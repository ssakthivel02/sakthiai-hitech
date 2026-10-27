import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import { getDb, getWorkspaceForUser, getWorkspaceRole, searchChunks } from "../db";
import { isLowInformationQuery } from "../retrieval";
import { ArtifactError, createArtifactFromMessage, deleteArtifact, getArtifact, listArtifacts, searchArtifacts, updateArtifact, type ArtifactErrorCode } from "./store";
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
const errorCode = { CONVERSATION_DENIED: "FORBIDDEN", PROJECT_DENIED: "FORBIDDEN", MESSAGE_NOT_FOUND: "NOT_FOUND", NOT_FOUND: "NOT_FOUND", NOT_SAVEABLE: "PRECONDITION_FAILED", TOO_LARGE: "PAYLOAD_TOO_LARGE", MODIFY_DENIED: "FORBIDDEN", INVALID: "BAD_REQUEST" } as const satisfies Record<ArtifactErrorCode, TRPCError["code"]>;
/** Membership was already proven by requireWorkspace; the role decides whether the caller may change artifacts saved by others. */
async function actorFor(userId: number, workspaceId: number) { return { userId, isWorkspaceOwner: (await getWorkspaceRole(userId, workspaceId)) === "owner" }; }
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
  /** Rename and/or move to another project (projectId: null removes it from its project). Creator or workspace owner only. */
  update: protectedProcedure
    .input(workspaceInput.extend({ artifactId: z.number().int().positive(), title: z.string().max(400).optional(), projectId: z.number().int().positive().nullable().optional() }).refine(value => value.title !== undefined || value.projectId !== undefined, { message: "Nothing to change" }))
    .mutation(async ({ ctx, input }) => {
      await requireWorkspace(ctx.user.id, input.workspaceId);
      const db = await requireDb();
      return guard(async () => updateArtifact(db, { workspaceId: input.workspaceId, actor: await actorFor(ctx.user.id, input.workspaceId), artifactId: input.artifactId, title: input.title, projectId: input.projectId }));
    }),
  /** Permanently deletes the artifact (not its source chat or files). Creator or workspace owner only. */
  delete: protectedProcedure
    .input(workspaceInput.extend({ artifactId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      await requireWorkspace(ctx.user.id, input.workspaceId);
      const db = await requireDb();
      return guard(async () => deleteArtifact(db, { workspaceId: input.workspaceId, actor: await actorFor(ctx.user.id, input.workspaceId), artifactId: input.artifactId }));
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
