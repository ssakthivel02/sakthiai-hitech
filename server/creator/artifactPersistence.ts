import { createHash } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { creatorArtifactLeases, creatorAssets, creatorGenerations, creatorProviderJobs, creatorShots } from "../../drizzle/schema";
import { getDb } from "../db";
import { storagePut, storageVerifySha256 } from "../storage";
import { CREATOR_STORED_MEDIA_MAX_BYTES } from "./storageIntegrity";
import { assertCreatorArtifactJobOwnership } from "./artifactJobOwnership";
import { acquireCreatorArtifactLease, assertCreatorArtifactLeaseActive, releaseCreatorArtifactLease } from "./artifactLease";
import {
  assertCreatorJobTransition,
  canTransitionCreatorJob,
  type CreatorJobState,
  type CreatorMediaProvider,
  type CreatorProviderArtifact,
} from "./types";

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
    "audio/wav": "wav",
  };
  const extension = extensions[normalized];
  if (!extension) throw new Error("CREATOR_ARTIFACT_MIME_UNSUPPORTED");
  return extension;
}

export function shouldMarkCreatorArtifactRetryable(input: {
  status: CreatorJobState;
  outputAssetId: number | null;
}): boolean {
  return input.outputAssetId === null && canTransitionCreatorJob(input.status, "RETRYABLE");
}

export function assetTypeForGeneration(kind: string): "IMAGE" | "VIDEO" | "AUDIO" {
  if (kind === "IMAGE" || kind === "IMAGE_EDIT") return "IMAGE";
  if (kind === "VIDEO" || kind === "VIDEO_EXTENSION" || kind === "AVATAR_VIDEO") return "VIDEO";
  if (kind === "SPEECH") return "AUDIO";
  throw new Error("CREATOR_ARTIFACT_KIND_UNSUPPORTED");
}

async function requireDb() {
  const db = await getDb();
  if (!db) throw new Error("CREATOR_DATABASE_UNAVAILABLE");
  return db;
}

type ExpectedArtifactJob = {
  workspaceId: number;
  creatorProjectId: number;
  generationId: number;
  provider: string;
  providerJobId: string;
};

async function assertLatestCreatorArtifactJob(
  db: Awaited<ReturnType<typeof requireDb>>,
  expected: ExpectedArtifactJob,
): Promise<void> {
  const [job] = await db.select().from(creatorProviderJobs)
    .where(and(eq(creatorProviderJobs.workspaceId, expected.workspaceId), eq(creatorProviderJobs.generationId, expected.generationId)))
    .orderBy(desc(creatorProviderJobs.id)).limit(1);
  assertCreatorArtifactJobOwnership({ ...expected, job: job ?? null });
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

  if (generation.provider !== input.provider.id) throw new Error("CREATOR_ARTIFACT_PROVIDER_MISMATCH");

  const expectedJob = {
    workspaceId: input.workspaceId,
    creatorProjectId: generation.creatorProjectId,
    generationId: generation.id,
    provider: generation.provider,
    providerJobId: input.providerJobId,
  };
  // Check the latest provider job before replay, retrieval, or storage mutation.
  await assertLatestCreatorArtifactJob(db, expectedJob);

  if (generation.outputAssetId) {
    const [existing] = await db
      .select()
      .from(creatorAssets)
      .where(and(eq(creatorAssets.id, generation.outputAssetId), eq(creatorAssets.workspaceId, input.workspaceId), eq(creatorAssets.creatorProjectId, generation.creatorProjectId)))
      .limit(1);
    if (!existing) throw new Error("CREATOR_GENERATION_OUTPUT_ASSET_MISSING");
    if (generation.status !== "SUCCEEDED") throw new Error("CREATOR_GENERATION_OUTPUT_STATE_INVALID");
    if (typeof existing.byteSize !== "number" || !Number.isSafeInteger(existing.byteSize) || existing.byteSize < 1) {
      throw new Error("CREATOR_GENERATION_OUTPUT_SIZE_INVALID");
    }
    // Replays must not report success for missing or corrupted stored bytes.
    await storageVerifySha256(existing.storageKey, existing.byteSize, existing.checksumSha256);
    return { assetId: existing.id, storageKey: existing.storageKey, checksumSha256: existing.checksumSha256, reused: true };
  }

  if (!input.provider.fetchArtifact) throw new Error("CREATOR_PROVIDER_ARTIFACT_FETCH_UNSUPPORTED");
  assertCreatorJobTransition(generation.status as CreatorJobState, "SUCCEEDED");

  const leaseToken = await acquireCreatorArtifactLease(expectedJob);
  try {
  const fetched = await input.provider.fetchArtifact(input.artifact);
  const data = Buffer.from(fetched.data);
  if (!data.byteLength) throw new Error("CREATOR_ARTIFACT_EMPTY");
  if (data.byteLength > CREATOR_STORED_MEDIA_MAX_BYTES) throw new Error("CREATOR_ARTIFACT_TOO_LARGE");
  const mimeType = fetched.mimeType.split(";", 1)[0].trim().toLowerCase();
  const extension = extensionForCreatorMimeType(mimeType);
  const checksumSha256 = createHash("sha256").update(data).digest("hex");
  // Provider retrieval is asynchronous; reject jobs superseded during fetch.
  await assertLatestCreatorArtifactJob(db, expectedJob);
  const persistedAt = new Date();
  await assertCreatorArtifactLeaseActive(expectedJob, leaseToken);
  const storage = await storagePut(
    `creator/${generation.creatorProjectId}/shots/${generation.shotId ?? "unbound"}/generation-${generation.id}.${extension}`,
    data,
    mimeType,
  );
  // Do not create an APPROVED/PENDING database asset for a corrupted or missing object.
  await storageVerifySha256(storage.key, data.byteLength, checksumSha256);

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

  // Serialize finalization with submission and polling on the generation row.
  const finalized = await db.transaction(async tx => {
    const [currentGeneration] = await tx.select().from(creatorGenerations)
      .where(and(
        eq(creatorGenerations.id, generation.id),
        eq(creatorGenerations.workspaceId, input.workspaceId),
        eq(creatorGenerations.creatorProjectId, generation.creatorProjectId),
      )).limit(1).for("update");
    if (!currentGeneration) throw new Error("CREATOR_GENERATION_NOT_FOUND");
    if (currentGeneration.provider !== expectedJob.provider) {
      throw new Error("CREATOR_ARTIFACT_PROVIDER_JOB_MISMATCH");
    }

    const [currentJob] = await tx.select().from(creatorProviderJobs)
      .where(and(
        eq(creatorProviderJobs.workspaceId, expectedJob.workspaceId),
        eq(creatorProviderJobs.creatorProjectId, expectedJob.creatorProjectId),
        eq(creatorProviderJobs.generationId, expectedJob.generationId),
      )).orderBy(desc(creatorProviderJobs.id)).limit(1).for("update");
    assertCreatorArtifactJobOwnership({ ...expectedJob, job: currentJob ?? null });

    // The same generation-row lock serializes claim takeover and finalization.
    const [activeLease] = await tx.select().from(creatorArtifactLeases)
      .where(and(
        eq(creatorArtifactLeases.generationId, generation.id),
        eq(creatorArtifactLeases.workspaceId, input.workspaceId),
        eq(creatorArtifactLeases.creatorProjectId, generation.creatorProjectId),
      )).limit(1).for("update");
    if (!activeLease || activeLease.leaseToken !== leaseToken ||
        activeLease.providerJobId !== input.providerJobId ||
        new Date(activeLease.leaseUntil).getTime() <= Date.now()) {
      throw new Error("CREATOR_ARTIFACT_LEASE_LOST");
    }

    // A competing poller can finalize while provider bytes are being fetched.
    // Reuse its committed asset rather than creating another database asset.
    if (currentGeneration.outputAssetId !== null) {
      if (currentGeneration.status !== "SUCCEEDED") throw new Error("CREATOR_GENERATION_OUTPUT_STATE_INVALID");
      const [existing] = await tx.select().from(creatorAssets)
        .where(and(
          eq(creatorAssets.id, currentGeneration.outputAssetId),
          eq(creatorAssets.workspaceId, input.workspaceId),
          eq(creatorAssets.creatorProjectId, generation.creatorProjectId),
        )).limit(1);
      if (!existing) throw new Error("CREATOR_GENERATION_OUTPUT_ASSET_MISSING");
      if (typeof existing.byteSize !== "number" || !Number.isSafeInteger(existing.byteSize) || existing.byteSize < 1) {
        throw new Error("CREATOR_GENERATION_OUTPUT_SIZE_INVALID");
      }
      return { assetId: existing.id, storageKey: existing.storageKey, checksumSha256: existing.checksumSha256,
        byteSize: existing.byteSize, reused: true as const };
    }

    assertCreatorJobTransition(currentGeneration.status as CreatorJobState, "SUCCEEDED");
    const assetResult = await tx.insert(creatorAssets).values({
      workspaceId: input.workspaceId,
      creatorProjectId: currentGeneration.creatorProjectId,
      sceneId: currentGeneration.sceneId,
      shotId: currentGeneration.shotId,
      assetType: assetTypeForGeneration(currentGeneration.kind),
      mimeType,
      storageKey: storage.key,
      checksumSha256,
      byteSize: data.byteLength,
      immutable: 0,
      provenanceJson: JSON.stringify(provenance),
      reviewDecision: "PENDING",
    });
    const assetId = Number(assetResult[0].insertId);
    if (!assetId) throw new Error("CREATOR_ASSET_CREATE_FAILED");

    const updateResult = await tx.update(creatorGenerations).set({
      outputAssetId: assetId,
      status: "SUCCEEDED",
      failureClass: null,
      errorMessage: null,
      completedAt: persistedAt,
    }).where(and(
      eq(creatorGenerations.id, currentGeneration.id),
      eq(creatorGenerations.workspaceId, input.workspaceId),
      eq(creatorGenerations.creatorProjectId, currentGeneration.creatorProjectId),
      eq(creatorGenerations.status, currentGeneration.status),
      isNull(creatorGenerations.outputAssetId),
    ));
    if (Number(updateResult[0].affectedRows) !== 1) throw new Error("CREATOR_GENERATION_ARTIFACT_RACE");

    if (currentGeneration.shotId) {
      await tx.update(creatorShots).set({ status: "READY" }).where(and(
        eq(creatorShots.id, currentGeneration.shotId),
        eq(creatorShots.workspaceId, input.workspaceId),
        eq(creatorShots.creatorProjectId, currentGeneration.creatorProjectId),
      ));
    }
    // Claim release commits atomically with the generation output pointer.
    await tx.delete(creatorArtifactLeases).where(and(
      eq(creatorArtifactLeases.generationId, generation.id),
      eq(creatorArtifactLeases.leaseToken, leaseToken),
    ));
    return { assetId, storageKey: storage.key, checksumSha256, byteSize: data.byteLength, reused: false as const };
  });

  // Never report replay success for missing or corrupted persisted bytes.
  // Storage readback occurs after releasing the InnoDB generation-row lock.
  if (finalized.reused) {
    await storageVerifySha256(finalized.storageKey, finalized.byteSize, finalized.checksumSha256);
  }
  return { assetId: finalized.assetId, storageKey: finalized.storageKey,
    checksumSha256: finalized.checksumSha256, reused: finalized.reused };
  } finally {
    // On storage/provider failure release only our own token. A crashed worker
    // leaves an expiring claim for reconciliation, never a paid re-submission.
    await releaseCreatorArtifactLease(expectedJob, leaseToken).catch(() => undefined);
  }
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

  const status = generation.status as CreatorJobState;
  if (!shouldMarkCreatorArtifactRetryable({ status, outputAssetId: generation.outputAssetId })) return;
  assertCreatorJobTransition(status, "RETRYABLE");

  const message = input.error instanceof Error ? input.error.message : "CREATOR_ARTIFACT_PERSISTENCE_FAILED";
  await db
    .update(creatorGenerations)
    .set({ status: "RETRYABLE", failureClass: "ARTIFACT", errorMessage: message.slice(0, 2000), completedAt: null })
    .where(
      and(
        eq(creatorGenerations.id, generation.id),
        eq(creatorGenerations.workspaceId, input.workspaceId),
        eq(creatorGenerations.status, status),
        isNull(creatorGenerations.outputAssetId),
      ),
    );
}
