import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { creatorAssets, creatorGenerations, creatorShots } from "../../drizzle/schema";
import { getDb } from "../db";
import { storagePut } from "../storage";
import { assertCreatorJobTransition, type CreatorJobState, type CreatorMediaProvider, type CreatorProviderArtifact } from "./types";

function safeJson(value: string | null) {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

export function extensionForCreatorMimeType(mimeType: string): string {
  const normalized = mimeType.split(";", 1)[0].trim().toLowerCase();
  const extensions: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "video/mp4": "mp4",
  };
  const extension = extensions[normalized];
  if (!extension) throw new Error("CREATOR_ARTIFACT_MIME_UNSUPPORTED");
  return extension;
}

function assetTypeForGeneration(kind: string): "IMAGE" | "VIDEO" {
  if (kind === "IMAGE" || kind === "IMAGE_EDIT") return "IMAGE";
  if (kind === "VIDEO" || kind === "VIDEO_EXTENSION") return "VIDEO";
  throw new Error("CREATOR_ARTIFACT_KIND_UNSUPPORTED");
}

async function requireDb() {
  const db = await getDb();
  if (!db) throw new Error("CREATOR_DATABASE_UNAVAILABLE");
  return db;
}

export async function persistCreatorGenerationArtifact(input: {
  workspaceId: number;
  generationId: number;
  providerJobId: string;
  provider: CreatorMediaProvider;
  artifact: CreatorProviderArtifact;
}) {
  const db = await requireDb();
  const [generation] = await db
    .select()
    .from(creatorGenerations)
    .where(and(eq(creatorGenerations.id, input.generationId), eq(creatorGenerations.workspaceId, input.workspaceId)))
    .limit(1);
  if (!generation) throw new Error("CREATOR_GENERATION_NOT_FOUND");

  if (generation.outputAssetId) {
    const [existing] = await db
      .select()
      .from(creatorAssets)
      .where(and(eq(creatorAssets.id, generation.outputAssetId), eq(creatorAssets.workspaceId, input.workspaceId)))
      .limit(1);
    if (!existing) throw new Error("CREATOR_GENERATION_OUTPUT_ASSET_MISSING");
    return { assetId: existing.id, storageKey: existing.storageKey, checksumSha256: existing.checksumSha256, reused: true };
  }

  if (generation.provider !== input.provider.id) throw new Error("CREATOR_ARTIFACT_PROVIDER_MISMATCH");
  if (!input.provider.fetchArtifact) throw new Error("CREATOR_PROVIDER_ARTIFACT_FETCH_UNSUPPORTED");
  assertCreatorJobTransition(generation.status as CreatorJobState, "SUCCEEDED");

  const fetched = await input.provider.fetchArtifact(input.artifact);
  const data = Buffer.from(fetched.data);
  if (!data.byteLength) throw new Error("CREATOR_ARTIFACT_EMPTY");
  const mimeType = fetched.mimeType.split(";", 1)[0].trim().toLowerCase();
  const extension = extensionForCreatorMimeType(mimeType);
  const checksumSha256 = createHash("sha256").update(data).digest("hex");
  const persistedAt = new Date();
  const storage = await storagePut(
    `creator/${generation.creatorProjectId}/shots/${generation.shotId ?? "unbound"}/generation-${generation.id}.${extension}`,
    data,
    mimeType,
  );

  const provenance = {
    schemaVersion: 1,
    creatorProjectId: generation.creatorProjectId,
    sceneId: generation.sceneId,
    shotId: generation.shotId,
    generationId: generation.id,
    provider: generation.provider,
    providerJobId: input.providerJobId,
    model: generation.model,
    parameters: safeJson(generation.parametersJson),
    sourceAssetIds: safeJson(generation.sourceAssetIdsJson),
    sourceArtifactTransport: input.artifact.dataBase64 ? "INLINE_BASE64" : input.artifact.uri ? "PROVIDER_URI" : "UNKNOWN",
    persistedAt: persistedAt.toISOString(),
    checksumSha256,
  };

  let assetId = 0;
  await db.transaction(async tx => {
    const assetResult = await tx.insert(creatorAssets).values({
      workspaceId: input.workspaceId,
      creatorProjectId: generation.creatorProjectId,
      sceneId: generation.sceneId,
      shotId: generation.shotId,
      assetType: assetTypeForGeneration(generation.kind),
      mimeType,
      storageKey: storage.key,
      checksumSha256,
      byteSize: data.byteLength,
      immutable: 0,
      provenanceJson: JSON.stringify(provenance),
      reviewDecision: "PENDING",
    });
    assetId = Number(assetResult[0].insertId);
    if (!assetId) throw new Error("CREATOR_ASSET_CREATE_FAILED");

    const updateResult = await tx
      .update(creatorGenerations)
      .set({
        outputAssetId: assetId,
        status: "SUCCEEDED",
        failureClass: null,
        errorMessage: null,
        completedAt: persistedAt,
      })
      .where(
        and(
          eq(creatorGenerations.id, generation.id),
          eq(creatorGenerations.workspaceId, input.workspaceId),
          eq(creatorGenerations.status, generation.status),
        ),
      );
    if (Number(updateResult[0].affectedRows) !== 1) throw new Error("CREATOR_GENERATION_ARTIFACT_RACE");

    if (generation.shotId) {
      await tx
        .update(creatorShots)
        .set({ status: "READY" })
        .where(
          and(
            eq(creatorShots.id, generation.shotId),
            eq(creatorShots.workspaceId, input.workspaceId),
            eq(creatorShots.creatorProjectId, generation.creatorProjectId),
          ),
        );
    }
  });

  return { assetId, storageKey: storage.key, checksumSha256, reused: false };
}

export async function markCreatorArtifactRetryable(input: {
  workspaceId: number;
  generationId: number;
  error: unknown;
}) {
  const db = await requireDb();
  const [generation] = await db
    .select()
    .from(creatorGenerations)
    .where(and(eq(creatorGenerations.id, input.generationId), eq(creatorGenerations.workspaceId, input.workspaceId)))
    .limit(1);
  if (!generation) throw new Error("CREATOR_GENERATION_NOT_FOUND");
  assertCreatorJobTransition(generation.status as CreatorJobState, "RETRYABLE");
  const message = input.error instanceof Error ? input.error.message : "CREATOR_ARTIFACT_PERSISTENCE_FAILED";
  await db
    .update(creatorGenerations)
    .set({ status: "RETRYABLE", failureClass: "ARTIFACT", errorMessage: message.slice(0, 2000), completedAt: null })
    .where(and(eq(creatorGenerations.id, generation.id), eq(creatorGenerations.workspaceId, input.workspaceId)));
}
