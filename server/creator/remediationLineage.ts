import { sql } from "drizzle-orm";
import { getDb } from "../db";
import { storageVerifySha256 } from "../storage";

/** Explicit, append-only attribution of a failed candidate to one new render.
 * This records lineage only; it never generates, approves or publishes media.
 */
type CandidateRow = {
  id: number; workspaceId: number; creatorProjectId: number; assetType: string;
  mimeType: string; immutable: number; reviewDecision: string;
  storageKey: string; checksumSha256: string; byteSize: number | null;
  provenanceJson: string;
};
type QualityRow = { id: number; assetId: number | null; decision: string; scoresJson: string | null };
type ExportRow = {
  id: number; assetId: number | null; status: string; checksumSha256: string | null;
  width: number; height: number; renderer: string; format: string;
};
function rowsOf<T>(result: unknown): T[] {
  return Array.isArray(result) && Array.isArray(result[0]) ? result[0] as T[] : [];
}
function insertedId(result: unknown): number {
  return Array.isArray(result) ? Number((result[0] as { insertId?: number } | undefined)?.insertId ?? 0) : 0;
}
function requireId(id: number): void {
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("CREATOR_REMEDIATION_ID_INVALID");
}
function requireChecksum(value: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error("CREATOR_REMEDIATION_CHECKSUM_INVALID");
  return value;
}
function provenance(asset: CandidateRow) {
  let p: Record<string, unknown>;
  try { p = JSON.parse(asset.provenanceJson); }
  catch { throw new Error("CREATOR_REMEDIATION_PROVENANCE_INVALID"); }
  if (!p || p.source !== "deterministic-creator-render" ||
      !Number.isSafeInteger(p.timelineId) || Number(p.timelineId) <= 0 ||
      !Number.isSafeInteger(p.exportId) || Number(p.exportId) <= 0 ||
      !Number.isSafeInteger(p.audioMasterAssetId) ||
      typeof p.audioMasterChecksumSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(p.audioMasterChecksumSha256) ||
      !Number.isSafeInteger(p.width) || !Number.isSafeInteger(p.height) ||
      !Number.isSafeInteger(p.fps) || !Number.isSafeInteger(p.durationMs)) {
    throw new Error("CREATOR_REMEDIATION_PROVENANCE_INVALID");
  }
  return p as { timelineId: number; exportId: number; audioMasterAssetId: number;
    audioMasterChecksumSha256: string; width: number; height: number; fps: number; durationMs: number };
}
function requireCandidate(asset: CandidateRow | undefined, expectedChecksum: string): asserts asset is CandidateRow {
  if (!asset || asset.assetType !== "RENDER" || asset.mimeType !== "video/mp4" ||
      Number(asset.immutable) !== 1 || asset.reviewDecision !== "PENDING" ||
      asset.checksumSha256 !== expectedChecksum ||
      !asset.storageKey || !Number.isSafeInteger(asset.byteSize) || Number(asset.byteSize) <= 0) {
    throw new Error("CREATOR_REMEDIATION_CANDIDATE_INVALID");
  }
}
function requireExport(row: ExportRow | undefined, asset: CandidateRow, p: ReturnType<typeof provenance>): void {
  if (!row || Number(row.id) !== p.exportId || Number(row.assetId) !== Number(asset.id) ||
      row.status !== "SUCCEEDED" || row.renderer !== "ffmpeg" || row.format !== "mp4" ||
      row.checksumSha256 !== asset.checksumSha256 ||
      Number(row.width) !== p.width || Number(row.height) !== p.height) {
    throw new Error("CREATOR_REMEDIATION_EXPORT_UNVERIFIED");
  }
}

export async function linkCreatorRemediationReplacement(input: {
  workspaceId: number; creatorProjectId: number; reviewerUserId: number;
  sourceCandidateAssetId: number; sourceQualityReviewId: number;
  replacementCandidateAssetId: number;
  expectedSourceChecksumSha256: string; expectedReplacementChecksumSha256: string;
}) {
  for (const id of [input.workspaceId, input.creatorProjectId, input.reviewerUserId,
    input.sourceCandidateAssetId, input.sourceQualityReviewId, input.replacementCandidateAssetId]) requireId(id);
  const sourceSha = requireChecksum(input.expectedSourceChecksumSha256);
  const replacementSha = requireChecksum(input.expectedReplacementChecksumSha256);
  if (input.replacementCandidateAssetId <= input.sourceCandidateAssetId || sourceSha === replacementSha) {
    throw new Error("CREATOR_REMEDIATION_REPLACEMENT_NOT_DISTINCT");
  }
  const db = await getDb();
  if (!db) throw new Error("CREATOR_DATABASE_UNAVAILABLE");
  return db.transaction(async tx => {
    // Serialize with existing review mutations on both candidate asset rows.
    const assets = rowsOf<CandidateRow>(await tx.execute(sql`
      SELECT * FROM creatorAssets WHERE workspaceId = ${input.workspaceId}
        AND creatorProjectId = ${input.creatorProjectId}
        AND id IN (${input.sourceCandidateAssetId}, ${input.replacementCandidateAssetId})
      ORDER BY id FOR UPDATE
    `));
    const source = assets.find(x => Number(x.id) === input.sourceCandidateAssetId);
    const replacement = assets.find(x => Number(x.id) === input.replacementCandidateAssetId);
    requireCandidate(source, sourceSha);
    requireCandidate(replacement, replacementSha);
    const sourceP = provenance(source);
    const replacementP = provenance(replacement);
    if (sourceP.timelineId !== replacementP.timelineId ||
        sourceP.audioMasterAssetId !== replacementP.audioMasterAssetId ||
        sourceP.audioMasterChecksumSha256 !== replacementP.audioMasterChecksumSha256 ||
        sourceP.width !== 1920 || sourceP.height !== 1080 ||
        replacementP.width !== sourceP.width || replacementP.height !== sourceP.height ||
        replacementP.fps !== sourceP.fps || replacementP.durationMs !== sourceP.durationMs) {
      throw new Error("CREATOR_REMEDIATION_SOURCE_DRIFT");
    }
    const [quality] = rowsOf<QualityRow>(await tx.execute(sql`
      SELECT id, assetId, decision, scoresJson FROM creatorReviews
      WHERE id = ${input.sourceQualityReviewId} AND workspaceId = ${input.workspaceId}
        AND creatorProjectId = ${input.creatorProjectId} AND reviewType = 'QUALITY' FOR UPDATE
    `));
    if (!quality || Number(quality.assetId) !== source.id || quality.decision !== "REGENERATE") {
      throw new Error("CREATOR_REMEDIATION_FAILED_QUALITY_REQUIRED");
    }
    let bound: { candidateArtifact?: { checksumSha256?: string; storageKey?: string; byteSize?: number } };
    try { bound = JSON.parse(quality.scoresJson ?? ""); }
    catch { throw new Error("CREATOR_REMEDIATION_QUALITY_BINDING_INVALID"); }
    if (bound?.candidateArtifact?.checksumSha256 !== sourceSha ||
        bound.candidateArtifact.storageKey !== source.storageKey ||
        Number(bound.candidateArtifact.byteSize) !== Number(source.byteSize)) {
      throw new Error("CREATOR_REMEDIATION_QUALITY_BINDING_INVALID");
    }
    const [prior] = rowsOf<{ id: number }>(await tx.execute(sql`
      SELECT id FROM creatorRemediationLineage
      WHERE sourceQualityReviewId = ${quality.id} OR replacementCandidateAssetId = ${replacement.id}
      LIMIT 1 FOR UPDATE
    `));
    if (prior) throw new Error("CREATOR_REMEDIATION_ALREADY_LINKED");
    const [replacementReview] = rowsOf<{ id: number }>(await tx.execute(sql`
      SELECT id FROM creatorReviews WHERE workspaceId = ${input.workspaceId}
        AND creatorProjectId = ${input.creatorProjectId} AND assetId = ${replacement.id}
      LIMIT 1 FOR UPDATE
    `));
    if (replacementReview) throw new Error("CREATOR_REMEDIATION_REPLACEMENT_ALREADY_REVIEWED");
    const exports = rowsOf<ExportRow>(await tx.execute(sql`
      SELECT id, assetId, status, checksumSha256, width, height, renderer, format
      FROM creatorExports WHERE workspaceId = ${input.workspaceId}
        AND creatorProjectId = ${input.creatorProjectId} AND timelineId = ${sourceP.timelineId}
        AND id IN (${sourceP.exportId}, ${replacementP.exportId})
      ORDER BY id FOR UPDATE
    `));
    requireExport(exports.find(x => Number(x.id) === sourceP.exportId), source, sourceP);
    requireExport(exports.find(x => Number(x.id) === replacementP.exportId), replacement, replacementP);
    // A database checksum alone cannot attest to durable, unchanged object bytes.
    try {
      await storageVerifySha256(source.storageKey, Number(source.byteSize), sourceSha);
      await storageVerifySha256(replacement.storageKey, Number(replacement.byteSize), replacementSha);
    } catch { throw new Error("CREATOR_REMEDIATION_STORAGE_UNVERIFIED"); }
    const inserted = await tx.execute(sql`
      INSERT INTO creatorRemediationLineage
        (workspaceId, creatorProjectId, timelineId, sourceCandidateAssetId,
         sourceQualityReviewId, sourceChecksumSha256, replacementCandidateAssetId,
         replacementChecksumSha256, createdByUserId)
      VALUES (${input.workspaceId}, ${input.creatorProjectId}, ${sourceP.timelineId},
        ${source.id}, ${quality.id}, ${sourceSha}, ${replacement.id}, ${replacementSha},
        ${input.reviewerUserId})
    `);
    const lineageId = insertedId(inserted);
    if (!lineageId) throw new Error("CREATOR_REMEDIATION_LINEAGE_CREATE_FAILED");
    return { lineageId, sourceCandidateAssetId: source.id, sourceQualityReviewId: quality.id,
      replacementCandidateAssetId: replacement.id, replacementChecksumSha256: replacementSha,
      replacementRequiresFreshQuality: true, replacementRequiresFreshTamilReview: true,
      replacementRequiresFreshVisualReview: true, finalMaster: false, publishApproved: false };
  });
}
