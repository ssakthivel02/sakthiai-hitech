import { and, eq, inArray } from "drizzle-orm";
import { creatorAssets, creatorReferences } from "../../../drizzle/schema";
import { getDb } from "../../db";
import type { ScenePlan } from "./scenePlan";
import { bindApprovedMuruganAnchors, type ApprovedAnchorReferenceRow, type MuruganAnchorSelection } from "./approvedAnchorBindings";

/**
 * Resolve reference/asset identities exclusively from the database with BOTH
 * workspace and project predicates. Does not fetch image bytes or call providers.
 * The returned graph can be passed to the existing conditioned-frame resolver.
 */
export async function resolveApprovedMuruganAnchorGraph(input: {
  workspaceId: number;
  creatorProjectId: number;
  plan: ScenePlan;
  selection: MuruganAnchorSelection;
}) {
  const db = await getDb();
  if (!db) throw new Error("CREATOR_DATABASE_UNAVAILABLE");
  const ids = Object.values(input.selection).filter((v): v is NonNullable<typeof v> => Boolean(v)).map(v => v.referenceId);
  if (!ids.length || ids.length > 3 || ids.some(id => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error("MURUGAN_ANCHOR_SELECTION_INVALID");
  }
  const rows = await db.select({
    referenceId: creatorReferences.id,
    assetId: creatorAssets.id,
    workspaceId: creatorAssets.workspaceId,
    creatorProjectId: creatorAssets.creatorProjectId,
    kind: creatorReferences.kind,
    label: creatorReferences.label,
    referenceImmutable: creatorReferences.immutable,
    approvedAt: creatorReferences.approvedAt,
    assetType: creatorAssets.assetType,
    assetImmutable: creatorAssets.immutable,
    reviewDecision: creatorAssets.reviewDecision,
    mimeType: creatorAssets.mimeType,
    checksumSha256: creatorAssets.checksumSha256,
    storageKey: creatorAssets.storageKey,
  }).from(creatorReferences)
    .innerJoin(creatorAssets, eq(creatorReferences.assetId, creatorAssets.id))
    .where(and(
      inArray(creatorReferences.id, ids),
      eq(creatorReferences.workspaceId, input.workspaceId),
      eq(creatorReferences.creatorProjectId, input.creatorProjectId),
      eq(creatorAssets.workspaceId, input.workspaceId),
      eq(creatorAssets.creatorProjectId, input.creatorProjectId),
    ));
  return bindApprovedMuruganAnchors({ ...input, rows: rows as ApprovedAnchorReferenceRow[] });
}
