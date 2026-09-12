import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  creatorAssets,
  creatorCaptionCues,
  creatorExports,
  creatorGenerations,
  creatorProjects,
  creatorProviderJobs,
  creatorReferences,
  creatorReviews,
  creatorScenes,
  creatorShots,
  creatorTimelineItems,
  creatorTimelines,
} from "../../drizzle/schema";
import { protectedProcedure, router } from "../_core/trpc";
import { getDb, getWorkspaceForUser } from "../db";

const workspaceInput = z.object({ workspaceId: z.number().int().positive() });
const projectInput = workspaceInput.extend({ creatorProjectId: z.number().int().positive() });

async function requireWorkspace(userId: number, workspaceId: number) {
  const workspace = await getWorkspaceForUser(userId, workspaceId);
  if (!workspace) throw new TRPCError({ code: "FORBIDDEN", message: "Workspace access denied" });
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "CREATOR_DATABASE_UNAVAILABLE" });
  return db;
}

async function requireProject(userId: number, workspaceId: number, creatorProjectId: number) {
  const db = await requireWorkspace(userId, workspaceId);
  const [project] = await db
    .select()
    .from(creatorProjects)
    .where(and(eq(creatorProjects.id, creatorProjectId), eq(creatorProjects.workspaceId, workspaceId)))
    .limit(1);
  if (!project) throw new TRPCError({ code: "NOT_FOUND", message: "CREATOR_PROJECT_NOT_FOUND" });
  return { db, project };
}

export const creatorWorkspaceRouter = router({
  listProjects: protectedProcedure.input(workspaceInput).query(async ({ ctx, input }) => {
    const db = await requireWorkspace(ctx.user.id, input.workspaceId);
    return db.select().from(creatorProjects).where(eq(creatorProjects.workspaceId, input.workspaceId)).orderBy(desc(creatorProjects.updatedAt));
  }),

  createProject: protectedProcedure
    .input(workspaceInput.extend({
      name: z.string().trim().min(1).max(180),
      canonicalLyrics: z.string().trim().max(100_000).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await requireWorkspace(ctx.user.id, input.workspaceId);
      const result = await db.insert(creatorProjects).values({
        workspaceId: input.workspaceId,
        name: input.name,
        canonicalLyrics: input.canonicalLyrics || null,
        status: "DRAFT",
      });
      const id = Number(result[0].insertId);
      if (!id) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "CREATOR_PROJECT_CREATE_FAILED" });
      const [project] = await db.select().from(creatorProjects).where(and(eq(creatorProjects.id, id), eq(creatorProjects.workspaceId, input.workspaceId))).limit(1);
      return project;
    }),

  getProject: protectedProcedure.input(projectInput).query(async ({ ctx, input }) => {
    const { db, project } = await requireProject(ctx.user.id, input.workspaceId, input.creatorProjectId);
    const scope = and(eq(creatorProjects.workspaceId, input.workspaceId), eq(creatorProjects.id, input.creatorProjectId));
    void scope;
    const [scenes, shots, assets, references, generations, providerJobs, timelines, timelineItems, captionCues, reviews, exports] = await Promise.all([
      db.select().from(creatorScenes).where(and(eq(creatorScenes.workspaceId, input.workspaceId), eq(creatorScenes.creatorProjectId, input.creatorProjectId))).orderBy(asc(creatorScenes.sceneIndex)),
      db.select().from(creatorShots).where(and(eq(creatorShots.workspaceId, input.workspaceId), eq(creatorShots.creatorProjectId, input.creatorProjectId))).orderBy(asc(creatorShots.sceneId), asc(creatorShots.shotIndex)),
      db.select().from(creatorAssets).where(and(eq(creatorAssets.workspaceId, input.workspaceId), eq(creatorAssets.creatorProjectId, input.creatorProjectId))).orderBy(desc(creatorAssets.createdAt)),
      db.select().from(creatorReferences).where(and(eq(creatorReferences.workspaceId, input.workspaceId), eq(creatorReferences.creatorProjectId, input.creatorProjectId))).orderBy(desc(creatorReferences.createdAt)),
      db.select().from(creatorGenerations).where(and(eq(creatorGenerations.workspaceId, input.workspaceId), eq(creatorGenerations.creatorProjectId, input.creatorProjectId))).orderBy(desc(creatorGenerations.createdAt)),
      db.select().from(creatorProviderJobs).where(and(eq(creatorProviderJobs.workspaceId, input.workspaceId), eq(creatorProviderJobs.creatorProjectId, input.creatorProjectId))).orderBy(desc(creatorProviderJobs.updatedAt)),
      db.select().from(creatorTimelines).where(and(eq(creatorTimelines.workspaceId, input.workspaceId), eq(creatorTimelines.creatorProjectId, input.creatorProjectId))).orderBy(desc(creatorTimelines.updatedAt)),
      db.select().from(creatorTimelineItems).where(and(eq(creatorTimelineItems.workspaceId, input.workspaceId), eq(creatorTimelineItems.creatorProjectId, input.creatorProjectId))).orderBy(asc(creatorTimelineItems.timelineId), asc(creatorTimelineItems.sortOrder)),
      db.select().from(creatorCaptionCues).where(and(eq(creatorCaptionCues.workspaceId, input.workspaceId), eq(creatorCaptionCues.creatorProjectId, input.creatorProjectId))).orderBy(asc(creatorCaptionCues.timelineId), asc(creatorCaptionCues.startMs)),
      db.select().from(creatorReviews).where(and(eq(creatorReviews.workspaceId, input.workspaceId), eq(creatorReviews.creatorProjectId, input.creatorProjectId))).orderBy(desc(creatorReviews.createdAt)),
      db.select().from(creatorExports).where(and(eq(creatorExports.workspaceId, input.workspaceId), eq(creatorExports.creatorProjectId, input.creatorProjectId))).orderBy(desc(creatorExports.createdAt)),
    ]);
    return { project, scenes, shots, assets, references, generations, providerJobs, timelines, timelineItems, captionCues, reviews, exports };
  }),

  createScene: protectedProcedure
    .input(projectInput.extend({
      sceneIndex: z.number().int().min(0),
      title: z.string().trim().min(1).max(180),
      startMs: z.number().int().min(0).optional(),
      endMs: z.number().int().positive().optional(),
      notes: z.string().max(20_000).optional(),
    }).refine(value => value.startMs === undefined || value.endMs === undefined || value.endMs > value.startMs, { message: "CREATOR_SCENE_TIME_RANGE_INVALID" }))
    .mutation(async ({ ctx, input }) => {
      const { db } = await requireProject(ctx.user.id, input.workspaceId, input.creatorProjectId);
      const duplicate = await db.select({ id: creatorScenes.id }).from(creatorScenes).where(and(
        eq(creatorScenes.workspaceId, input.workspaceId),
        eq(creatorScenes.creatorProjectId, input.creatorProjectId),
        eq(creatorScenes.sceneIndex, input.sceneIndex),
      )).limit(1);
      if (duplicate[0]) throw new TRPCError({ code: "CONFLICT", message: "CREATOR_SCENE_INDEX_EXISTS" });
      const result = await db.insert(creatorScenes).values({
        workspaceId: input.workspaceId,
        creatorProjectId: input.creatorProjectId,
        sceneIndex: input.sceneIndex,
        title: input.title,
        startMs: input.startMs ?? null,
        endMs: input.endMs ?? null,
        notes: input.notes ?? null,
      });
      return { id: Number(result[0].insertId) };
    }),

  createShot: protectedProcedure
    .input(projectInput.extend({
      sceneId: z.number().int().positive(),
      shotIndex: z.number().int().min(0),
      title: z.string().trim().min(1).max(180),
      prompt: z.string().max(8_000).optional(),
      startMs: z.number().int().min(0).optional(),
      endMs: z.number().int().positive().optional(),
    }).refine(value => value.startMs === undefined || value.endMs === undefined || value.endMs > value.startMs, { message: "CREATOR_SHOT_TIME_RANGE_INVALID" }))
    .mutation(async ({ ctx, input }) => {
      const { db } = await requireProject(ctx.user.id, input.workspaceId, input.creatorProjectId);
      const [scene] = await db.select({ id: creatorScenes.id }).from(creatorScenes).where(and(
        eq(creatorScenes.id, input.sceneId),
        eq(creatorScenes.workspaceId, input.workspaceId),
        eq(creatorScenes.creatorProjectId, input.creatorProjectId),
      )).limit(1);
      if (!scene) throw new TRPCError({ code: "NOT_FOUND", message: "CREATOR_SCENE_NOT_FOUND" });
      const duplicate = await db.select({ id: creatorShots.id }).from(creatorShots).where(and(
        eq(creatorShots.workspaceId, input.workspaceId),
        eq(creatorShots.creatorProjectId, input.creatorProjectId),
        eq(creatorShots.sceneId, input.sceneId),
        eq(creatorShots.shotIndex, input.shotIndex),
      )).limit(1);
      if (duplicate[0]) throw new TRPCError({ code: "CONFLICT", message: "CREATOR_SHOT_INDEX_EXISTS" });
      const result = await db.insert(creatorShots).values({
        workspaceId: input.workspaceId,
        creatorProjectId: input.creatorProjectId,
        sceneId: input.sceneId,
        shotIndex: input.shotIndex,
        title: input.title,
        prompt: input.prompt ?? null,
        startMs: input.startMs ?? null,
        endMs: input.endMs ?? null,
        status: "PLANNED",
      });
      return { id: Number(result[0].insertId) };
    }),
});