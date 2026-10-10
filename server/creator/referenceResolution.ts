import { and, asc, eq } from "drizzle-orm";
import { creatorAssets, creatorReferences } from "../../drizzle/schema";
import { getDb } from "../db";
import { storageRead } from "../storage";
import type { CreatorInlineImage } from "./types";

export type LockedReferenceRow = {
  referenceId: number;
  assetId: number;
  kind: "CHARACTER" | "STYLE" | "LOCATION" | "OBJECT";
  label: string;
  mimeType: string;
  storageKey: string;
  immutable: number;
  reviewDecision: "PENDING" | "APPROVED" | "REJECTED";
};

const KIND_PRIORITY: Record<LockedReferenceRow["kind"], number> = {
  CHARACTER: 0,
  STYLE: 1,
  LOCATION: 2,
  OBJECT: 3,
};

export function selectLockedReferences(rows: LockedReferenceRow[], limit: number): LockedReferenceRow[] {
  if (!Number.isInteger(limit) || limit < 0) throw new Error("CREATOR_REFERENCE_LIMIT_INVALID");
  return rows
    .filter(row => row.immutable === 1 && row.reviewDecision === "APPROVED")
    .sort((a, b) => KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind] || a.referenceId - b.referenceId)
    .slice(0, limit);
}

export async function resolveApprovedProjectReferenceImages(input: {
  workspaceId: number;
  creatorProjectId: number;
  limit: number;
}): Promise<CreatorInlineImage[]> {
  const db = await getDb();
  if (!db) throw new Error("CREATOR_DATABASE_UNAVAILABLE");

  const rows = await db
    .select({
      referenceId: creatorReferences.id,
      assetId: creatorReferences.assetId,
      kind: creatorReferences.kind,
      label: creatorReferences.label,
      mimeType: creatorAssets.mimeType,
      storageKey: creatorAssets.storageKey,
      immutable: creatorReferences.immutable,
      reviewDecision: creatorAssets.reviewDecision,
    })
    .from(creatorReferences)
    .innerJoin(creatorAssets, eq(creatorAssets.id, creatorReferences.assetId))
    .where(and(
      eq(creatorReferences.workspaceId, input.workspaceId),
      eq(creatorReferences.creatorProjectId, input.creatorProjectId),
      eq(creatorAssets.workspaceId, input.workspaceId),
      eq(creatorAssets.creatorProjectId, input.creatorProjectId),
    ))
    .orderBy(asc(creatorReferences.id));

  const selected = selectLockedReferences(rows as LockedReferenceRow[], input.limit);
  const images: CreatorInlineImage[] = [];
  for (const row of selected) {
    if (!["image/png", "image/jpeg", "image/webp"].includes(row.mimeType)) {
      throw new Error("CREATOR_REFERENCE_MIME_UNSUPPORTED");
    }
    const bytes = await storageRead(row.storageKey);
    if (!bytes.byteLength) throw new Error("CREATOR_REFERENCE_STORAGE_EMPTY");
    images.push({
      mimeType: row.mimeType as CreatorInlineImage["mimeType"],
      dataBase64: Buffer.from(bytes).toString("base64"),
      assetId: row.assetId,
    });
  }
  return images;
}
