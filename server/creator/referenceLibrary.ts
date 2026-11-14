import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { creatorAssets, creatorProjects, creatorReferences, creatorScenes, creatorShots } from "../../drizzle/schema";
import { getDb } from "../db";
import { storagePut } from "../storage";

export type CreatorReferenceKind = "CHARACTER" | "STYLE" | "LOCATION" | "OBJECT";

async function requireDb() {
  const db = await getDb();
  if (!db) throw new Error("CREATOR_DATABASE_UNAVAILABLE");
  return db;
}

export function validateShotTiming(startMs: number, endMs: number) {
  if (!Number.isInteger(startMs) || !Number.isInteger(endMs) || startMs < 0 || endMs <= startMs) {
    throw new Error("CREATOR_SHOT_TIME_RANGE_INVALID");
  }
  return { startMs, endMs };
}

export async function ingestApprovedReference(input: {
  workspaceId: number;
  creatorProjectId: number;
  filename: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  data: Buffer;
  kind: CreatorReferenceKind;
  label: string;
  approvedByUserId: number;
}) {
  if (!input.data.length) throw new Error("CREATOR_REFERENCE_EMPTY");
  if (input.data.byteLength > 20 * 1024 * 1024) throw new Error("CREATOR_REFERENCE_TOO_LARGE");
  const label = input.label.trim();
  if (!label) throw new Error("CREATOR_REFERENCE_LABEL_REQUIRED");

  const db = await requireDb();
  const [project] = await db.select({ id: creatorProjects.id }).from(creatorProjects).where(and(
    eq(creatorProjects.id, input.creatorProjectId),
    eq(creatorProjects.workspaceId, input.workspaceId),
  )).limit(1);
  if (!project) throw new Error("CREATOR_PROJECT_NOT_FOUND");

  const checksumSha256 = createHash("sha256").update(input.data).digest("hex");
  const [duplicateAsset] = await db.select({ id: creatorAssets.id }).from(creatorAssets).where(and(
    eq(creatorAssets.workspaceId, input.workspaceId),
    eq(creatorAssets.creatorProjectId, input.creatorProjectId),
    eq(creatorAssets.checksumSha256, checksumSha256),
  )).limit(1);
  if (duplicateAsset) throw new Error("CREATOR_REFERENCE_DUPLICATE_ASSET");

  const [duplicateLabel] = await db.select({ id: creatorReferences.id }).from(creatorReferences).where(and(
    eq(creatorReferences.workspaceId, input.workspaceId),
    eq(creatorReferences.creatorProjectId, input.creatorProjectId),
    eq(creatorReferences.kind, input.kind),
    eq(creatorReferences.label, label),
  )).limit(1);
  if (duplicateLabel) throw new Error("CREATOR_REFERENCE_LABEL_EXISTS");

  const safeFilename = input.filename.normalize("NFKC").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 180) || "reference";
  const stored = await storagePut(
    `creator/${input.workspaceId}/${input.creatorProjectId}/references/${input.kind.toLowerCase()}/${checksumSha256.slice(0, 16)}-${safeFilename}`,
    input.data,
    input.mimeType,
  );

  const provenance = {
    source: "human-approved-reference-upload",
    kind: input.kind,
    label,
    approvedByUserId: input.approvedByUserId,
    checksumSha256,
    immutableReference: true,
    ingestedAt: new Date().toISOString(),
  };

  const assetResult = await db.insert(creatorAssets).values({
    workspaceId: input.workspaceId,
    creatorProjectId: input.creatorProjectId,
    assetType: "REFERENCE",
    mimeType: input.mimeType,
    storageKey: stored.key,
    checksumSha256,
    byteSize: input.data.byteLength,
    immutable: 1,
    provenanceJson: JSON.stringify(provenance),
    reviewDecision: "APPROVED",
  });
  const assetId = Number(assetResult[0].insertId);
  if (!assetId) throw new Error("CREATOR_REFERENCE_ASSET_CREATE_FAILED");

  const referenceResult = await db.insert(creatorReferences).values({
    workspaceId: input.workspaceId,
    creatorProjectId: input.creatorProjectId,
    assetId,
    kind: input.kind,
    label,
    immutable: 1,
    approvedAt: new Date(),
  });
  const referenceId = Number(referenceResult[0].insertId);
  if (!referenceId) throw new Error("CREATOR_REFERENCE_CREATE_FAILED");

  return { referenceId, assetId, kind: input.kind, label, checksumSha256, storageKey: stored.key, immutable: true as const, approved: true as const };
}

export async function updateCreatorShotTiming(input: {
  workspaceId: number;
  creatorProjectId: number;
  shotId: number;
  startMs: number;
  endMs: number;
}) {
  const { startMs, endMs } = validateShotTiming(input.startMs, input.endMs);
  const db = await requireDb();
  const [shot] = await db.select({ id: creatorShots.id, sceneId: creatorShots.sceneId }).from(creatorShots).where(and(
    eq(creatorShots.id, input.shotId),
    eq(creatorShots.workspaceId, input.workspaceId),
    eq(creatorShots.creatorProjectId, input.creatorProjectId),
  )).limit(1);
  if (!shot) throw new Error("CREATOR_SHOT_NOT_FOUND");

  const [scene] = await db.select({ startMs: creatorScenes.startMs, endMs: creatorScenes.endMs }).from(creatorScenes).where(and(
    eq(creatorScenes.id, shot.sceneId),
    eq(creatorScenes.workspaceId, input.workspaceId),
    eq(creatorScenes.creatorProjectId, input.creatorProjectId),
  )).limit(1);
  if (!scene) throw new Error("CREATOR_SCENE_NOT_FOUND");
  if (scene.startMs !== null && startMs < scene.startMs) throw new Error("CREATOR_SHOT_BEFORE_SCENE");
  if (scene.endMs !== null && endMs > scene.endMs) throw new Error("CREATOR_SHOT_AFTER_SCENE");

  await db.update(creatorShots).set({ startMs, endMs }).where(and(
    eq(creatorShots.id, input.shotId),
    eq(creatorShots.workspaceId, input.workspaceId),
    eq(creatorShots.creatorProjectId, input.creatorProjectId),
  ));
  return { shotId: input.shotId, startMs, endMs };
}
