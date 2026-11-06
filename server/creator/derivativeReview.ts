import { and, eq } from "drizzle-orm";
import { creatorAssets, creatorReviews } from "../../drizzle/schema";
import { getDb } from "../db";
import { DERIVATIVE_SOURCE } from "./renderService";

/**
 * Human check of a 9:16 delivery derivative's crop (did the centre-crop cut off the Vel, faces or the peacock?).
 * PASS approves that exact derivative for delivery; REJECT marks it rejected. One decision per asset, race-safe.
 * This never touches the 16:9 master and never makes a derivative a master.
 */
type Row = { id: number; workspaceId: number; creatorProjectId: number; assetType: string; immutable: number; reviewDecision: string; checksumSha256: string; provenanceJson: string };

export function assertDerivativeReviewable(row: Row | undefined, input: { workspaceId: number; creatorProjectId: number }) {
  if (!row || row.workspaceId !== input.workspaceId || row.creatorProjectId !== input.creatorProjectId) throw new Error("CREATOR_DERIVATIVE_REVIEW_NOT_FOUND");
  let p: { source?: unknown; derivativeOfRenderAssetId?: unknown };
  try { p = JSON.parse(row.provenanceJson); } catch { throw new Error("CREATOR_DERIVATIVE_REVIEW_NOT_FOUND"); }
  if (row.assetType !== "RENDER" || row.immutable !== 1 || p.source !== DERIVATIVE_SOURCE || !Number.isInteger(p.derivativeOfRenderAssetId)) {
    throw new Error("CREATOR_DERIVATIVE_REVIEW_NOT_FOUND");
  }
  if (row.reviewDecision !== "PENDING") throw new Error("CREATOR_DERIVATIVE_REVIEW_ALREADY_FINAL");
  return { parentRenderAssetId: p.derivativeOfRenderAssetId as number };
}

export async function reviewVerticalDerivative(input: {
  workspaceId: number; creatorProjectId: number; assetId: number; reviewerUserId: number; decision: "PASS" | "REJECT"; notes: string;
}) {
  if (!input.notes.trim()) throw new Error("CREATOR_HUMAN_REVIEW_NOTES_REQUIRED");
  const db = await getDb();
  if (!db) throw new Error("CREATOR_DATABASE_UNAVAILABLE");
  const scoped = (id: number) => and(eq(creatorAssets.id, id), eq(creatorAssets.workspaceId, input.workspaceId), eq(creatorAssets.creatorProjectId, input.creatorProjectId));
  const [row] = await db.select().from(creatorAssets).where(scoped(input.assetId)).limit(1);
  const { parentRenderAssetId } = assertDerivativeReviewable(row as Row | undefined, input);
  const [parent] = await db.select({ reviewDecision: creatorAssets.reviewDecision }).from(creatorAssets).where(scoped(parentRenderAssetId)).limit(1);
  if (parent?.reviewDecision !== "APPROVED") throw new Error("CREATOR_DERIVATIVE_MASTER_NOT_FINAL");

  let reviewId = 0;
  await db.transaction(async tx => {
    const updated = await tx.update(creatorAssets)
      .set({ reviewDecision: input.decision === "PASS" ? "APPROVED" : "REJECTED" })
      .where(and(scoped(input.assetId), eq(creatorAssets.reviewDecision, "PENDING")));
    if (Number(updated[0].affectedRows) !== 1) throw new Error("CREATOR_DERIVATIVE_REVIEW_ALREADY_FINAL");
    const inserted = await tx.insert(creatorReviews).values({
      workspaceId: input.workspaceId, creatorProjectId: input.creatorProjectId, assetId: input.assetId,
      reviewType: "HUMAN_VISUAL", decision: input.decision, reviewerUserId: input.reviewerUserId,
      scoresJson: JSON.stringify({ check: "VERTICAL_CROP", parentRenderAssetId, approvedChecksumSha256: row!.checksumSha256 }),
      notes: input.notes.trim(),
    });
    reviewId = Number(inserted[0].insertId);
  });
  return { reviewId, assetId: input.assetId, decision: input.decision, deliveryApproved: input.decision === "PASS", finalMaster: false as const, publishApproved: false as const };
}
