import { and, desc, eq, isNull } from "drizzle-orm";
import { creatorConsents } from "../../../drizzle/schema";
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
