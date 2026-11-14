/**
 * UI-only guard for human Creator review. The server remains authoritative
 * for ownership, measured output evidence and final-master promotion.
 * A newly rendered asset must never inherit an earlier asset's watch/approval.
 */
export type CreatorReviewEvidence = {
  assetId: number | null;
  reviewType: string;
  decision: string;
};

export function creatorReviewReadiness(input: {
  candidateId?: number;
  candidateDecision?: string;
  watchedAssetId?: number;
  notes: string;
  source: string;
  qualityScores: Record<string, string>;
  dimensionIds: readonly string[];
  reviews: readonly CreatorReviewEvidence[];
}) {
  const { candidateId, candidateDecision, watchedAssetId, notes, source, qualityScores, dimensionIds, reviews } = input;
  const pending = Number.isInteger(candidateId) && Number(candidateId) > 0 && candidateDecision === "PENDING";
  const watched = pending && watchedAssetId === candidateId;
  const hasNotes = notes.trim().length > 0;
  const candidateReviews = reviews.filter(review => review.assetId === candidateId);
  const quality = candidateReviews.find(review => review.reviewType === "QUALITY");
  const tamil = candidateReviews.find(review => review.reviewType === "HUMAN_TAMIL");
  const visual = candidateReviews.find(review => review.reviewType === "HUMAN_VISUAL");
  const scoresComplete = dimensionIds.length > 0 && dimensionIds.every(id => {
    const raw = qualityScores[id];
    if (typeof raw !== "string" || !raw.trim()) return false;
    const score = Number(raw);
    return Number.isFinite(score) && score >= 0 && score <= 5;
  });

  return {
    watched,
    scoresComplete,
    quality: watched && hasNotes && source.trim().length > 0 && scoresComplete && !quality,
    tamilPass: watched && hasNotes && quality?.decision === "PASS" && !tamil,
    visualPass: watched && hasNotes && quality?.decision === "PASS" && !visual,
    tamilReject: pending && hasNotes && quality?.decision === "PASS" && !tamil,
    visualReject: pending && hasNotes && quality?.decision === "PASS" && !visual,
    finalize: watched && quality?.decision === "PASS" && tamil?.decision === "PASS" && visual?.decision === "PASS",
  };
}
