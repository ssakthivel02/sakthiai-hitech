import { and, eq } from "drizzle-orm";
import { creatorAssets, creatorReviews } from "../../../drizzle/schema";
import { getDb } from "../../db";

/**
 * Human review of GENERATED speech. A PASS approves and locks (immutable) the exact audio bytes reviewed, which is
 * what allows it to drive an avatar; a REJECT marks it rejected. One review per asset; the decision is final.
 * The reviewer is the authenticated workspace owner attesting they listened to it; SakthiAI cannot verify listening.
 */
export type SpeechAssetRow = {
  id: number; workspaceId: number; creatorProjectId: number; assetType: string; mimeType: string;
  immutable: number; reviewDecision: string; checksumSha256: string; provenanceJson: string;
};

export function speechProvenance(row: SpeechAssetRow): { languageCode: string; text: string; generationId: number } {
  let parsed: { generationId?: unknown; parameters?: { kind?: unknown; languageCode?: unknown; prompt?: unknown } };
  try { parsed = JSON.parse(row.provenanceJson); } catch { throw new Error("CREATOR_SPEECH_REVIEW_NOT_GENERATED_SPEECH"); }
  const p = parsed.parameters;
  if (p?.kind !== "SPEECH" || typeof p.prompt !== "string" || typeof p.languageCode !== "string" || !Number.isInteger(parsed.generationId)) {
    throw new Error("CREATOR_SPEECH_REVIEW_NOT_GENERATED_SPEECH");
  }
  return { languageCode: p.languageCode, text: p.prompt, generationId: parsed.generationId as number };
}

export function assertSpeechReviewable(row: SpeechAssetRow | undefined, input: { workspaceId: number; creatorProjectId: number }) {
  if (!row || row.workspaceId !== input.workspaceId || row.creatorProjectId !== input.creatorProjectId) throw new Error("CREATOR_SPEECH_REVIEW_ASSET_NOT_FOUND");
  if (row.assetType !== "AUDIO" || row.mimeType !== "audio/wav") throw new Error("CREATOR_SPEECH_REVIEW_NOT_GENERATED_SPEECH");
  if (row.reviewDecision !== "PENDING" || row.immutable !== 0) throw new Error("CREATOR_SPEECH_REVIEW_ALREADY_FINAL");
  return speechProvenance(row);
}

export async function reviewGeneratedSpeech(input: {
  workspaceId: number; creatorProjectId: number; assetId: number; reviewerUserId: number;
  decision: "PASS" | "REJECT"; notes: string;
}) {
  const db = await getDb();
  if (!db) throw new Error("CREATOR_DATABASE_UNAVAILABLE");
  const [row] = await db.select({
    id: creatorAssets.id, workspaceId: creatorAssets.workspaceId, creatorProjectId: creatorAssets.creatorProjectId,
    assetType: creatorAssets.assetType, mimeType: creatorAssets.mimeType, immutable: creatorAssets.immutable,
    reviewDecision: creatorAssets.reviewDecision, checksumSha256: creatorAssets.checksumSha256, provenanceJson: creatorAssets.provenanceJson,
  }).from(creatorAssets).where(and(
    eq(creatorAssets.id, input.assetId), eq(creatorAssets.workspaceId, input.workspaceId), eq(creatorAssets.creatorProjectId, input.creatorProjectId),
  )).limit(1);
  const speech = assertSpeechReviewable(row, input);

  let reviewId = 0;
  await db.transaction(async tx => {
    // Conditional on PENDING + mutable: two concurrent reviews cannot both succeed.
    const updated = await tx.update(creatorAssets)
      .set(input.decision === "PASS" ? { reviewDecision: "APPROVED", immutable: 1 } : { reviewDecision: "REJECTED" })
      .where(and(eq(creatorAssets.id, input.assetId), eq(creatorAssets.workspaceId, input.workspaceId), eq(creatorAssets.reviewDecision, "PENDING"), eq(creatorAssets.immutable, 0)));
    if (Number(updated[0].affectedRows) !== 1) throw new Error("CREATOR_SPEECH_REVIEW_ALREADY_FINAL");
    const inserted = await tx.insert(creatorReviews).values({
      workspaceId: input.workspaceId, creatorProjectId: input.creatorProjectId, generationId: speech.generationId, assetId: input.assetId,
      reviewType: "HUMAN_SPEECH", decision: input.decision, reviewerUserId: input.reviewerUserId,
      scoresJson: JSON.stringify({ languageCode: speech.languageCode, approvedChecksumSha256: row!.checksumSha256, reviewedTextCharacters: speech.text.length }),
      notes: input.notes.trim(),
    });
    reviewId = Number(inserted[0].insertId);
  });
  return {
    reviewId, assetId: input.assetId, decision: input.decision, languageCode: speech.languageCode,
    approved: input.decision === "PASS", locked: input.decision === "PASS", checksumSha256: row!.checksumSha256,
  };
}
