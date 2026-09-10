import { and, eq } from "drizzle-orm";
import { creatorAssets } from "../../drizzle/schema";
import { getDb } from "../db";
import { storageRead } from "../storage";
import type { CreatorReferenceImage } from "./types";

export type ConditionedFrameAssetRow = {
  id: number;
  workspaceId: number;
  creatorProjectId: number;
  assetType: string;
  mimeType: string;
  storageKey: string;
  immutable: number;
  reviewDecision: string;
};

export function validateConditionedFrameAsset(
  row: ConditionedFrameAssetRow | undefined,
  input: { workspaceId: number; creatorProjectId: number; assetId: number },
): ConditionedFrameAssetRow {
  if (!row) throw new Error("CREATOR_CONDITION_FRAME_ASSET_NOT_FOUND");
  if (row.workspaceId !== input.workspaceId || row.creatorProjectId !== input.creatorProjectId) {
    throw new Error("CREATOR_CONDITION_FRAME_ASSET_SCOPE_MISMATCH");
  }
  if (row.assetType !== "IMAGE" && row.assetType !== "REFERENCE") {
    throw new Error("CREATOR_CONDITION_FRAME_ASSET_NOT_IMAGE");
  }
  if (!["image/png", "image/jpeg", "image/webp"].includes(row.mimeType)) {
    throw new Error("CREATOR_CONDITION_FRAME_MIME_UNSUPPORTED");
  }
  if (row.immutable !== 1) throw new Error("CREATOR_CONDITION_FRAME_ASSET_MUTABLE");
  if (row.reviewDecision !== "APPROVED") throw new Error("CREATOR_CONDITION_FRAME_ASSET_NOT_APPROVED");
  return row;
}

export async function resolveApprovedConditionedFrameAsset(input: {
  workspaceId: number;
  creatorProjectId: number;
  assetId: number;
}): Promise<CreatorReferenceImage> {
  const db = await getDb();
  if (!db) throw new Error("CREATOR_DATABASE_UNAVAILABLE");

  const [row] = await db
    .select({
      id: creatorAssets.id,
      workspaceId: creatorAssets.workspaceId,
      creatorProjectId: creatorAssets.creatorProjectId,
      assetType: creatorAssets.assetType,
      mimeType: creatorAssets.mimeType,
      storageKey: creatorAssets.storageKey,
      immutable: creatorAssets.immutable,
      reviewDecision: creatorAssets.reviewDecision,
    })
    .from(creatorAssets)
    .where(and(eq(creatorAssets.id, input.assetId), eq(creatorAssets.workspaceId, input.workspaceId)))
    .limit(1);

  const approved = validateConditionedFrameAsset(row, input);
  const bytes = await storageRead(approved.storageKey);
  return {
    mimeType: approved.mimeType as CreatorReferenceImage["mimeType"],
    dataBase64: Buffer.from(bytes).toString("base64"),
    assetId: approved.id,
  };
}
