import { and, desc, eq } from "drizzle-orm";
import {
  creatorGenerations,
  creatorProjects,
  creatorProviderJobs,
  creatorShots,
} from "../../drizzle/schema";
import { getDb } from "../db";
import { generationStateAfterProviderState } from "./lifecycle";
import {
  assertCreatorJobTransition,
  type CreatorFailureClass,
  type CreatorJobState,
  type CreatorMediaKind,
  type CreatorProviderPoll,
  type CreatorProviderSubmission,
} from "./types";

async function requireDb() {
  const db = await getDb();
  if (!db) throw new Error("CREATOR_DATABASE_UNAVAILABLE");
  return db;
}

async function requireProjectAndShot(input: { workspaceId: number; creatorProjectId: number; shotId: number }) {
  const db = await requireDb();
  const [project] = await db
    .select({ id: creatorProjects.id })
    .from(creatorProjects)
    .where(and(eq(creatorProjects.id, input.creatorProjectId), eq(creatorProjects.workspaceId, input.workspaceId)))
    .limit(1);
  if (!project) throw new Error("CREATOR_PROJECT_NOT_FOUND");

  const [shot] = await db
    .select({ id: creatorShots.id })
    .from(creatorShots)
    .where(
      and(
        eq(creatorShots.id, input.shotId),
        eq(creatorShots.workspaceId, input.workspaceId),
        eq(creatorShots.creatorProjectId, input.creatorProjectId),
      ),
    )
    .limit(1);
  if (!shot) throw new Error("CREATOR_SHOT_NOT_FOUND");
  return db;
}

export async function createQueuedGeneration(input: {
  workspaceId: number;
  creatorProjectId: number;
  shotId: number;
  kind: CreatorMediaKind;
  provider: string;
  model: string;
  parameters: unknown;
  sourceAssetIds?: number[];
}) {
  const db = await requireProjectAndShot(input);
  const result = await db.insert(creatorGenerations).values({
    workspaceId: input.workspaceId,
    creatorProjectId: input.creatorProjectId,
    shotId: input.shotId,
    kind: input.kind,
    provider: input.provider,
    model: input.model,
    parametersJson: JSON.stringify(input.parameters),
    sourceAssetIdsJson: JSON.stringify(input.sourceAssetIds ?? []),
    status: "QUEUED",
    attempt: 1,
  });
  const generationId = Number(result[0].insertId);
  if (!generationId) throw new Error("CREATOR_GENERATION_CREATE_FAILED");
  return generationId;
}

export async function createQueuedVideoGeneration(input: {
  workspaceId: number;
  creatorProjectId: number;
  shotId: number;
  provider: string;
  model: string;
  parameters: unknown;
  sourceAssetIds?: number[];
}) {
  return createQueuedGeneration({ ...input, kind: "VIDEO" });
}

export async function recordProviderSubmission(input: {
  workspaceId: number;
  creatorProjectId: number;
  generationId: number;
  submission: CreatorProviderSubmission;
}) {
  const db = await requireDb();
  const [generation] = await db
    .select()
    .from(creatorGenerations)
    .where(
      and(
        eq(creatorGenerations.id, input.generationId),
        eq(creatorGenerations.workspaceId, input.workspaceId),
        eq(creatorGenerations.creatorProjectId, input.creatorProjectId),
      ),
    )
    .limit(1);
  if (!generation) throw new Error("CREATOR_GENERATION_NOT_FOUND");

  const generationState = generationStateAfterProviderState(input.submission.state);
  assertCreatorJobTransition(generation.status as CreatorJobState, generationState);
  const providerCompletedAt = input.submission.state === "SUCCEEDED" ? new Date() : null;

  await db.insert(creatorProviderJobs).values({
    workspaceId: input.workspaceId,
    creatorProjectId: input.creatorProjectId,
    generationId: input.generationId,
    provider: input.submission.provider,
    providerJobId: input.submission.providerJobId,
    status: input.submission.state,
    snapshotJson: JSON.stringify(input.submission.raw),
    costMicros: input.submission.costMicros ?? null,
    currency: input.submission.currency ?? null,
    completedAt: providerCompletedAt,
  });
  await db
    .update(creatorGenerations)
    .set({
      status: generationState,
      costMicros: input.submission.costMicros ?? null,
      currency: input.submission.currency ?? null,
      completedAt: null,
    })
    .where(eq(creatorGenerations.id, input.generationId));
}

export async function recordProviderPoll(input: {
  workspaceId: number;
  providerJobId: string;
  poll: CreatorProviderPoll;
}) {
  const db = await requireDb();
  const [job] = await db
    .select()
    .from(creatorProviderJobs)
    .where(and(eq(creatorProviderJobs.workspaceId, input.workspaceId), eq(creatorProviderJobs.providerJobId, input.providerJobId)))
    .limit(1);
  if (!job) throw new Error("CREATOR_PROVIDER_JOB_NOT_FOUND");

  const [generation] = await db
    .select()
    .from(creatorGenerations)
    .where(and(eq(creatorGenerations.id, job.generationId), eq(creatorGenerations.workspaceId, input.workspaceId)))
    .limit(1);
  if (!generation) throw new Error("CREATOR_GENERATION_NOT_FOUND");

  assertCreatorJobTransition(job.status as CreatorJobState, input.poll.state);
  const generationState = generationStateAfterProviderState(input.poll.state);
  assertCreatorJobTransition(generation.status as CreatorJobState, generationState);
  const providerCompletedAt = ["SUCCEEDED", "FAILED", "CANCELLED"].includes(input.poll.state) ? new Date() : null;
  const generationCompletedAt = ["FAILED", "CANCELLED"].includes(generationState) ? new Date() : null;

  await db
    .update(creatorProviderJobs)
    .set({
      status: input.poll.state,
      snapshotJson: JSON.stringify(input.poll.raw),
      failureClass: input.poll.failureClass ?? null,
      costMicros: input.poll.costMicros ?? null,
      currency: input.poll.currency ?? null,
      completedAt: providerCompletedAt,
    })
    .where(eq(creatorProviderJobs.id, job.id));

  await db
    .update(creatorGenerations)
    .set({
      status: generationState,
      failureClass: input.poll.failureClass ?? null,
      errorMessage: input.poll.errorMessage ?? null,
      costMicros: input.poll.costMicros ?? null,
      currency: input.poll.currency ?? null,
      completedAt: generationCompletedAt,
    })
    .where(eq(creatorGenerations.id, job.generationId));

  return {
    generationId: job.generationId,
    creatorProjectId: job.creatorProjectId,
    providerState: input.poll.state,
    generationState,
  };
}

export async function getGenerationExecutionContext(workspaceId: number, generationId: number) {
  const db = await requireDb();
  const [generation] = await db
    .select()
    .from(creatorGenerations)
    .where(and(eq(creatorGenerations.id, generationId), eq(creatorGenerations.workspaceId, workspaceId)))
    .limit(1);
  if (!generation) throw new Error("CREATOR_GENERATION_NOT_FOUND");

  const [providerJob] = await db
    .select()
    .from(creatorProviderJobs)
    .where(and(eq(creatorProviderJobs.generationId, generationId), eq(creatorProviderJobs.workspaceId, workspaceId)))
    .orderBy(desc(creatorProviderJobs.id))
    .limit(1);

  return { generation, providerJob: providerJob ?? null };
}

export async function markGenerationFailed(input: {
  workspaceId: number;
  creatorProjectId: number;
  generationId: number;
  failureClass: CreatorFailureClass;
  errorMessage: string;
}) {
  const db = await requireDb();
  await db
    .update(creatorGenerations)
    .set({ status: "FAILED", failureClass: input.failureClass, errorMessage: input.errorMessage, completedAt: new Date() })
    .where(
      and(
        eq(creatorGenerations.id, input.generationId),
        eq(creatorGenerations.workspaceId, input.workspaceId),
        eq(creatorGenerations.creatorProjectId, input.creatorProjectId),
      ),
    );
}
