import { and, eq } from "drizzle-orm";
import {
  creatorAvatarDispatchAdmissions,
  creatorGenerations,
  creatorProviderJobs,
} from "../../drizzle/schema";
import { getDb } from "../db";

function isDuplicateEntry(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; errno?: unknown; cause?: unknown };
  if (candidate.code === "ER_DUP_ENTRY" || candidate.errno === 1062) return true;
  return candidate.cause ? isDuplicateEntry(candidate.cause) : false;
}

function validateIdentity(value: string, code: string, max: number): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed !== value || trimmed.length > max) throw new Error(code);
  return trimmed;
}

/**
 * Attach an already-existing provider job to an ambiguous avatar generation.
 *
 * This is reconciliation only: it never calls a provider, never creates a new
 * spend reservation, and never authorizes a retry. The caller is responsible
 * for obtaining authoritative provider evidence before invoking this function.
 */
export async function attachReconciledAvatarProviderJob(input: {
  workspaceId: number;
  generationId: number;
  callbackId: string;
  provider: string;
  model: string;
  providerJobId: string;
  evidence?: unknown;
}): Promise<{ generationId: number; providerJobId: string; attached: boolean; state: "SUBMITTED" }> {
  if (!Number.isSafeInteger(input.workspaceId) || input.workspaceId < 1) throw new Error("CREATOR_RECONCILIATION_WORKSPACE_INVALID");
  if (!Number.isSafeInteger(input.generationId) || input.generationId < 1) throw new Error("CREATOR_RECONCILIATION_GENERATION_INVALID");
  const callbackId = validateIdentity(input.callbackId, "CREATOR_RECONCILIATION_CALLBACK_INVALID", 64);
  const provider = validateIdentity(input.provider, "CREATOR_RECONCILIATION_PROVIDER_INVALID", 80);
  const model = validateIdentity(input.model, "CREATOR_RECONCILIATION_MODEL_INVALID", 160);
  const providerJobId = validateIdentity(input.providerJobId, "CREATOR_PROVIDER_JOB_ID_INVALID", 512);

  const db = await getDb();
  if (!db) throw new Error("CREATOR_DATABASE_UNAVAILABLE");

  try {
    return await db.transaction(async tx => {
      const [generation] = await tx
        .select()
        .from(creatorGenerations)
        .where(and(
          eq(creatorGenerations.id, input.generationId),
          eq(creatorGenerations.workspaceId, input.workspaceId),
        ))
        .limit(1)
        .for("update");

      if (!generation) throw new Error("CREATOR_GENERATION_NOT_FOUND");
      if (generation.kind !== "AVATAR_VIDEO" ||
          generation.provider !== provider ||
          generation.model !== model ||
          generation.idempotencyKey !== callbackId) {
        throw new Error("CREATOR_RECONCILIATION_CONFLICT");
      }

      const [admission] = await tx
        .select()
        .from(creatorAvatarDispatchAdmissions)
        .where(and(
          eq(creatorAvatarDispatchAdmissions.generationId, input.generationId),
          eq(creatorAvatarDispatchAdmissions.workspaceId, input.workspaceId),
        ))
        .limit(1)
        .for("update");

      if (!admission || admission.callbackId !== callbackId) {
        throw new Error("CREATOR_RECONCILIATION_CONFLICT");
      }

      const existingForGeneration = await tx
        .select()
        .from(creatorProviderJobs)
        .where(and(
          eq(creatorProviderJobs.workspaceId, input.workspaceId),
          eq(creatorProviderJobs.generationId, input.generationId),
        ))
        .limit(2)
        .for("update");

      if (existingForGeneration.length > 1) throw new Error("CREATOR_RECONCILIATION_CONFLICT");
      if (existingForGeneration.length === 1) {
        const existing = existingForGeneration[0];
        if (existing.provider !== provider || existing.providerJobId !== providerJobId) {
          throw new Error("CREATOR_RECONCILIATION_CONFLICT");
        }
        if (!["SUBMITTED", "RUNNING"].includes(generation.status)) {
          throw new Error("CREATOR_RECONCILIATION_CONFLICT");
        }
        return { generationId: generation.id, providerJobId, attached: false, state: "SUBMITTED" as const };
      }

      if (generation.status !== "SUBMISSION_UNKNOWN") {
        throw new Error("CREATOR_RECONCILIATION_CONFLICT");
      }

      const [owner] = await tx
        .select()
        .from(creatorProviderJobs)
        .where(and(
          eq(creatorProviderJobs.workspaceId, input.workspaceId),
          eq(creatorProviderJobs.providerJobId, providerJobId),
        ))
        .limit(1)
        .for("update");
      if (owner) throw new Error("CREATOR_RECONCILIATION_CONFLICT");

      await tx.insert(creatorProviderJobs).values({
        workspaceId: input.workspaceId,
        creatorProjectId: generation.creatorProjectId,
        generationId: generation.id,
        provider,
        providerJobId,
        status: "SUBMITTED",
        snapshotJson: JSON.stringify({
          reconciliation: "authoritative_existing_provider_job",
          evidence: input.evidence ?? null,
        }),
      });

      const result = await tx
        .update(creatorGenerations)
        .set({
          status: "SUBMITTED",
          failureClass: null,
          errorMessage: null,
          completedAt: null,
        })
        .where(and(
          eq(creatorGenerations.id, generation.id),
          eq(creatorGenerations.workspaceId, input.workspaceId),
          eq(creatorGenerations.status, "SUBMISSION_UNKNOWN"),
        ));
      const affectedRows = Number((result[0] as { affectedRows?: number } | undefined)?.affectedRows ?? 0);
      if (affectedRows !== 1) throw new Error("CREATOR_RECONCILIATION_CONFLICT");

      return { generationId: generation.id, providerJobId, attached: true, state: "SUBMITTED" as const };
    });
  } catch (error) {
    if (isDuplicateEntry(error)) throw new Error("CREATOR_RECONCILIATION_CONFLICT");
    throw error;
  }
}
