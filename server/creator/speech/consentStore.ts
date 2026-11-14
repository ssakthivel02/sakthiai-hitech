import { and, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
import { creatorAvatarDispatchAdmissions, creatorConsents, creatorGenerations } from "../../../drizzle/schema";
import { getDb } from "../../db";

export type ConsentPurpose = "avatar_video" | "custom_voice";
export type ConsentRow = {
  id: number;
  workspaceId: number;
  purpose: ConsentPurpose;
  provider: string;
  providerSubjectId: string;
  validUntil: Date | null;
  revokedAt: Date | null;
};

export const PROVIDER_SUBJECT_ID = /^[A-Za-z0-9_-]{4,128}$/;

/** Pure: the record must belong to this workspace, purpose, provider and subject, be unrevoked and unexpired. */
export function assertConsentActive(
  row: ConsentRow | undefined,
  expected: { workspaceId: number; purpose: ConsentPurpose; provider: string; providerSubjectId: string },
  now: Date = new Date(),
): ConsentRow {
  if (!row || row.workspaceId !== expected.workspaceId) throw new Error("CREATOR_CONSENT_NOT_FOUND");
  if (row.purpose !== expected.purpose) throw new Error("CREATOR_CONSENT_PURPOSE_MISMATCH");
  if (row.provider !== expected.provider || row.providerSubjectId !== expected.providerSubjectId) throw new Error("CREATOR_CONSENT_SUBJECT_MISMATCH");
  if (row.revokedAt) throw new Error("CREATOR_CONSENT_REVOKED");
  if (row.validUntil && row.validUntil.getTime() <= now.getTime()) throw new Error("CREATOR_CONSENT_EXPIRED");
  return row;
}

async function requireDb() {
  const db = await getDb();
  if (!db) throw new Error("CREATOR_DATABASE_UNAVAILABLE");
  return db;
}

export async function findActiveConsent(input: { workspaceId: number; consentId: number; purpose: ConsentPurpose; provider: string; providerSubjectId: string }) {
  const db = await requireDb();
  const [row] = await db.select().from(creatorConsents)
    .where(and(eq(creatorConsents.id, input.consentId), eq(creatorConsents.workspaceId, input.workspaceId)))
    .limit(1);
  return assertConsentActive(row as ConsentRow | undefined, input);
}

export async function recordConsent(input: {
  workspaceId: number; userId: number; purpose: ConsentPurpose; provider: string; providerSubjectId: string; evidenceReference: string; validUntil?: Date;
}) {
  if (!PROVIDER_SUBJECT_ID.test(input.providerSubjectId)) throw new Error("CREATOR_CONSENT_SUBJECT_INVALID");
  if (input.validUntil && input.validUntil.getTime() <= Date.now()) throw new Error("CREATOR_CONSENT_VALID_UNTIL_PAST");
  const db = await requireDb();
  const result = await db.insert(creatorConsents).values({
    workspaceId: input.workspaceId,
    purpose: input.purpose,
    provider: input.provider,
    providerSubjectId: input.providerSubjectId,
    evidenceReference: input.evidenceReference,
    grantedByUserId: input.userId,
    validUntil: input.validUntil ?? null,
  });
  const id = Number(result[0].insertId);
  if (!id) throw new Error("CREATOR_CONSENT_CREATE_FAILED");
  return { consentId: id };
}

/**
 * Durable admission boundary shared with revokeConsent's InnoDB row update.
 * Admission first: provider work may proceed despite subsequent revocation.
 * Revocation first: admission is rejected before any external request.
 * This is not evidence that the provider received a request: a crash after
 * admission is handled as an ambiguous submission, never a safe retry.
 */
export async function admitAvatarConsentDispatch(input: {
  workspaceId: number; consentId: number; purpose: ConsentPurpose; provider: string; providerSubjectId: string;
}) {
  const db = await requireDb();
  const result = await db.update(creatorConsents)
    .set({ lastDispatchAdmittedAt: sql`CURRENT_TIMESTAMP(6)` })
    .where(and(
      eq(creatorConsents.id, input.consentId),
      eq(creatorConsents.workspaceId, input.workspaceId),
      eq(creatorConsents.purpose, input.purpose),
      eq(creatorConsents.provider, input.provider),
      eq(creatorConsents.providerSubjectId, input.providerSubjectId),
      isNull(creatorConsents.revokedAt),
      or(isNull(creatorConsents.validUntil), gt(creatorConsents.validUntil, sql`CURRENT_TIMESTAMP(6)`)),
    ));
  if (Number(result[0].affectedRows) !== 1) throw new Error("CREATOR_CONSENT_REVOKED_OR_NOT_ACTIVE");
  return { consentId: input.consentId, admitted: true as const };
}

/**
 * Atomic, durable per-generation admission receipt. The row UPDATE serializes
 * with revocation; the receipt INSERT commits in the SAME transaction.
 * Admission is NOT proof that the remote provider accepted/billed a request.
 */
export async function admitAvatarGenerationDispatch(input: {
  workspaceId: number; consentId: number; purpose: ConsentPurpose; provider: string;
  providerSubjectId: string; generationId: number; callbackId: string;
}) {
  const db = await requireDb();
  return db.transaction(async tx => {
    const [generation] = await tx.select({ id: creatorGenerations.id })
      .from(creatorGenerations).where(and(
        eq(creatorGenerations.id, input.generationId),
        eq(creatorGenerations.workspaceId, input.workspaceId),
        eq(creatorGenerations.idempotencyKey, input.callbackId),
        eq(creatorGenerations.kind, "AVATAR_VIDEO"),
        eq(creatorGenerations.provider, input.provider),
        eq(creatorGenerations.status, "SUBMISSION_UNKNOWN"),
      )).limit(1);
    if (!generation) throw new Error("CREATOR_AVATAR_DISPATCH_GENERATION_MISMATCH");
    const result = await tx.update(creatorConsents)
      .set({ lastDispatchAdmittedAt: sql`CURRENT_TIMESTAMP(6)` })
      .where(and(
        eq(creatorConsents.id, input.consentId),
        eq(creatorConsents.workspaceId, input.workspaceId),
        eq(creatorConsents.purpose, input.purpose),
        eq(creatorConsents.provider, input.provider),
        eq(creatorConsents.providerSubjectId, input.providerSubjectId),
        isNull(creatorConsents.revokedAt),
        or(isNull(creatorConsents.validUntil), gt(creatorConsents.validUntil, sql`CURRENT_TIMESTAMP(6)`)),
      ));
    if (Number(result[0].affectedRows) !== 1) throw new Error("CREATOR_CONSENT_REVOKED_OR_NOT_ACTIVE");
    await tx.insert(creatorAvatarDispatchAdmissions).values({
      generationId: input.generationId, workspaceId: input.workspaceId,
      consentId: input.consentId, callbackId: input.callbackId,
    });
    return { generationId: input.generationId, consentId: input.consentId, admitted: true as const };
  });
}

/** Revocation is permanent and stops new generations; it cannot recall media a provider has already produced. */
export async function revokeConsent(input: { workspaceId: number; userId: number; consentId: number }) {
  const db = await requireDb();
  const result = await db.update(creatorConsents)
    .set({ revokedAt: new Date(), revokedByUserId: input.userId })
    .where(and(eq(creatorConsents.id, input.consentId), eq(creatorConsents.workspaceId, input.workspaceId), isNull(creatorConsents.revokedAt)));
  if (Number(result[0].affectedRows) !== 1) throw new Error("CREATOR_CONSENT_NOT_FOUND_OR_REVOKED");
  return { consentId: input.consentId, revoked: true as const };
}

export async function listConsents(workspaceId: number) {
  const db = await requireDb();
  return db.select({
    id: creatorConsents.id, purpose: creatorConsents.purpose, provider: creatorConsents.provider,
    providerSubjectId: creatorConsents.providerSubjectId, evidenceReference: creatorConsents.evidenceReference,
    validUntil: creatorConsents.validUntil, revokedAt: creatorConsents.revokedAt, createdAt: creatorConsents.createdAt,
  }).from(creatorConsents).where(eq(creatorConsents.workspaceId, workspaceId)).orderBy(desc(creatorConsents.id)).limit(200);
}
