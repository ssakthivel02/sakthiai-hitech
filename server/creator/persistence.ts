import { and, desc, eq, isNull } from "drizzle-orm";
import {
  creatorGenerations,
  creatorProjects,
  creatorProviderJobs,
  creatorShots,
} from "../../drizzle/schema";
import { getDb } from "../db";
import { generationStateAfterProviderState } from "./lifecycle";
import { assertSameGenerationIntent } from "./idempotency";
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

function isDuplicateEntry(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; errno?: unknown; cause?: unknown };
  if (candidate.code === "ER_DUP_ENTRY" || candidate.errno === 1062) return true;
  return candidate.cause ? isDuplicateEntry(candidate.cause) : false;
}

export async function createQueuedGeneration(input: {
  workspaceId: number;
  creatorProjectId: number;
  shotId: number;
  idempotencyKey: string;
  kind: CreatorMediaKind;
  provider: string;
  model: string;
  parameters: unknown;
  sourceAssetIds?: number[];
}) {
  const db = await requireProjectAndShot(input);
  const idempotencyKey = input.idempotencyKey.trim();
  if (!idempotencyKey) throw new Error("CREATOR_IDEMPOTENCY_KEY_REQUIRED");

  const parametersJson = JSON.stringify(input.parameters);
  const sourceAssetIdsJson = JSON.stringify(input.sourceAssetIds ?? []);
  const intent = {
    creatorProjectId: input.creatorProjectId,
    shotId: input.shotId,
    kind: input.kind,
    provider: input.provider,
    model: input.model,
    parametersJson,
    sourceAssetIdsJson,
  };

  try {
    const result = await db.insert(creatorGenerations).values({
      workspaceId: input.workspaceId,
      creatorProjectId: input.creatorProjectId,
      shotId: input.shotId,
      idempotencyKey,
      kind: input.kind,
      provider: input.provider,
      model: input.model,
      parametersJson,
      sourceAssetIdsJson,
      status: "QUEUED",
      attempt: 1,
    });
    const generationId = Number(result[0].insertId);
    if (!generationId) throw new Error("CREATOR_GENERATION_CREATE_FAILED");
    return { generationId, created: true as const };
  } catch (error) {
    if (!isDuplicateEntry(error)) throw error;
    const [existing] = await db
      .select()
      .from(creatorGenerations)
      .where(and(eq(creatorGenerations.workspaceId, input.workspaceId), eq(creatorGenerations.idempotencyKey, idempotencyKey)))
      .limit(1);
    if (!existing) throw error;
    assertSameGenerationIntent(existing, intent);
    return { generationId: existing.id, created: false as const };
  }
}

export async function createQueuedVideoGeneration(input: {
  workspaceId: number;
  creatorProjectId: number;
  shotId: number;
  idempotencyKey: string;
  provider: string;
  model: string;
  parameters: unknown;
  sourceAssetIds?: number[];
}) {
  return createQueuedGeneration({ ...input, kind: "VIDEO" });
}

export async function beginProviderSubmission(input: {
  workspaceId: number;
  creatorProjectId: number;
  generationId: number;
}) {
  const db = await requireDb();
  const result = await db
    .update(creatorGenerations)
    .set({ status: "SUBMISSION_UNKNOWN", failureClass: null, errorMessage: null })
    .where(
      and(
        eq(creatorGenerations.id, input.generationId),
        eq(creatorGenerations.workspaceId, input.workspaceId),
        eq(creatorGenerations.creatorProjectId, input.creatorProjectId),
        eq(creatorGenerations.status, "QUEUED"),
      ),
    );
  const affectedRows = Number((result[0] as { affectedRows?: number } | undefined)?.affectedRows ?? 0);
  if (affectedRows !== 1) throw new Error("CREATOR_SUBMISSION_STATE_CONFLICT");
}

export async function markGenerationSubmissionUnknown(input: {
  workspaceId: number;
  creatorProjectId: number;
  generationId: number;
  failureClass: CreatorFailureClass;
  errorMessage: string;
}) {
  const db = await requireDb();
  await db
    .update(creatorGenerations)
    .set({
      status: "SUBMISSION_UNKNOWN",
      failureClass: input.failureClass,
      errorMessage: input.errorMessage,
      completedAt: null,
    })
    .where(
      and(
        eq(creatorGenerations.id, input.generationId),
        eq(creatorGenerations.workspaceId, input.workspaceId),
        eq(creatorGenerations.creatorProjectId, input.creatorProjectId),
      ),
    );
}

export async function recordProviderSubmission(input: {
  workspaceId: number;
  creatorProjectId: number;
  generationId: number;
  submission: CreatorProviderSubmission;
}) {
  const db = await requireDb();
  await db.transaction(async tx => {
    const [generation] = await tx
      .select()
      .from(creatorGenerations)
      .where(
        and(
          eq(creatorGenerations.id, input.generationId),
          eq(creatorGenerations.workspaceId, input.workspaceId),
          eq(creatorGenerations.creatorProjectId, input.creatorProjectId),
        ),
      )
      .limit(1)
      .for("update");
    if (!generation) throw new Error("CREATOR_GENERATION_NOT_FOUND");

    // Shared serialization point: no new provider job can be recorded while
    // a poll for this generation is being finalized.
    const generationState = generationStateAfterProviderState(input.submission.state);
    assertCreatorJobTransition(generation.status as CreatorJobState, generationState);
    const providerCompletedAt = input.submission.state === "SUCCEEDED" ? new Date() : null;

    await tx.insert(creatorProviderJobs).values({
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
    await tx
      .update(creatorGenerations)
      .set({
        status: generationState,
        costMicros: input.submission.costMicros ?? null,
        currency: input.submission.currency ?? null,
        completedAt: null,
      })
      .where(eq(creatorGenerations.id, input.generationId));
  });
}

export async function recordProviderPoll(input: {
  workspaceId: number;
  providerJobId: string;
  poll: CreatorProviderPoll;
}) {
  if (!input.providerJobId || input.poll.providerJobId !== input.providerJobId) {
    throw new Error("CREATOR_PROVIDER_POLL_JOB_MISMATCH");
  }

  const db = await requireDb();
  return db.transaction(async tx => {
    // Provider IDs are not yet unique in the schema; ambiguity is unsafe.
    const jobs = await tx.select().from(creatorProviderJobs)
      .where(and(
        eq(creatorProviderJobs.workspaceId, input.workspaceId),
        eq(creatorProviderJobs.providerJobId, input.providerJobId),
      )).limit(2);
    if (jobs.length > 1) throw new Error("CREATOR_PROVIDER_JOB_AMBIGUOUS");
    const job = jobs[0];
    if (!job) throw new Error("CREATOR_PROVIDER_JOB_NOT_FOUND");

    // Lock the generation before inspecting the latest job. Submission uses
    // the same lock, preventing an older poll from superseding a newer job.
    const [generation] = await tx.select().from(creatorGenerations)
      .where(and(
        eq(creatorGenerations.id, job.generationId),
        eq(creatorGenerations.workspaceId, input.workspaceId),
        eq(creatorGenerations.creatorProjectId, job.creatorProjectId),
      )).limit(1).for("update");
    if (!generation) throw new Error("CREATOR_GENERATION_NOT_FOUND");

    const [latestJob] = await tx.select().from(creatorProviderJobs)
      .where(and(
        eq(creatorProviderJobs.workspaceId, input.workspaceId),
        eq(creatorProviderJobs.creatorProjectId, generation.creatorProjectId),
        eq(creatorProviderJobs.generationId, generation.id),
      )).orderBy(desc(creatorProviderJobs.id)).limit(1).for("update");
    if (!latestJob || latestJob.id !== job.id) {
      throw new Error("CREATOR_PROVIDER_JOB_SUPERSEDED");
    }
    if (latestJob.provider !== generation.provider || latestJob.providerJobId !== input.providerJobId) {
      throw new Error("CREATOR_PROVIDER_POLL_JOB_MISMATCH");
    }
    if (generation.outputAssetId !== null || generation.status === "SUCCEEDED") {
      throw new Error("CREATOR_PROVIDER_POLL_ALREADY_FINALIZED");
    }

    assertCreatorJobTransition(latestJob.status as CreatorJobState, input.poll.state);
    const generationState = generationStateAfterProviderState(input.poll.state);
    assertCreatorJobTransition(generation.status as CreatorJobState, generationState);
    const providerCompletedAt = ["SUCCEEDED", "FAILED", "CANCELLED"].includes(input.poll.state) ? new Date() : null;
    const generationCompletedAt = ["FAILED", "CANCELLED"].includes(generationState) ? new Date() : null;

    // A failed generation write rolls back the provider snapshot as well.
    await tx.update(creatorProviderJobs).set({
      status: input.poll.state,
      snapshotJson: JSON.stringify(input.poll.raw),
      failureClass: input.poll.failureClass ?? null,
      costMicros: input.poll.costMicros ?? null,
      currency: input.poll.currency ?? null,
      completedAt: providerCompletedAt,
    }).where(and(
      eq(creatorProviderJobs.id, latestJob.id),
      eq(creatorProviderJobs.workspaceId, input.workspaceId),
      eq(creatorProviderJobs.generationId, generation.id),
    ));

    await tx.update(creatorGenerations).set({
      status: generationState,
      failureClass: input.poll.failureClass ?? null,
      errorMessage: input.poll.errorMessage ?? null,
      costMicros: input.poll.costMicros ?? null,
      currency: input.poll.currency ?? null,
      completedAt: generationCompletedAt,
    }).where(and(
      eq(creatorGenerations.id, generation.id),
      eq(creatorGenerations.workspaceId, input.workspaceId),
      eq(creatorGenerations.creatorProjectId, generation.creatorProjectId),
      isNull(creatorGenerations.outputAssetId),
    ));

    return {
      generationId: generation.id,
      creatorProjectId: generation.creatorProjectId,
      providerState: input.poll.state,
      generationState,
    };
  });
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
