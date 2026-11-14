import { createHash } from "node:crypto";
import { CreateBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { beforeAll, describe, expect, it } from "vitest";
import { storageListCreatorRenderObjects, storagePut, storagePutCreatorStagedObject, storageVerifySha256 } from "./storage";
import { creatorArtifactStageKey } from "./creator/artifactStage";
import { inspectQuarantinedCreatorRender } from "./creator/renderReconciliation";
import type { getDb } from "./db";

/**
 * Actual MinIO S3 transport acceptance. Unlike storage.s3sdk.test.ts this
 * uses a real object-store implementation, not a hand-written HTTP fixture.
 * The explicit ACK, loopback host and disposable bucket guards are mandatory.
 * No production credentials, storage endpoint, or persistent data are touched.
 */
const enabled = process.env.CREATOR_MINIO_TEST_ACK === "disposable-local-only";
const bucket = process.env.STORAGE_BUCKET ?? "";
const endpoint = process.env.STORAGE_ENDPOINT ?? "";
const payload = Buffer.from("SakthiAI Murugan MinIO acceptance: வேல் முருகா", "utf8");
const digest = createHash("sha256").update(payload).digest("hex");
let s3: S3Client;

function scope(exportId: number) {
  return { workspaceId: 7, creatorProjectId: 11, timelineId: 13, exportId, claimId: exportId + 100 };
}
function assetRow(identity: ReturnType<typeof scope>, key: string, size = payload.length) {
  return {
    claimId: identity.claimId, exportId: identity.exportId,
    fingerprint: digest, exportStatus: "RUNNING",
    exportAssetId: 23, exportChecksum: digest,
    claimAssetId: 23, claimChecksum: digest,
    assetId: 23, assetType: "RENDER", assetImmutable: 1,
    assetKey: key, assetSize: size, assetChecksum: digest,
  };
}
function dbProvider(row: Record<string, unknown>) {
  return async () => ({
    execute: async () => [[row]],
  }) as unknown as NonNullable<Awaited<ReturnType<typeof getDb>>>;
}
async function putFor(identity: ReturnType<typeof scope>) {
  const baseKey = "creator/" + identity.workspaceId + "/" + identity.creatorProjectId +
    "/renders/timeline-" + identity.timelineId + "/export-" + identity.exportId + ".mp4";
  return (await storagePut(baseKey, payload, "video/mp4")).key;
}

describe.skipIf(!enabled)("Creator real MinIO storage reconciliation (disposable only)", () => {
  beforeAll(async () => {
    if (!endpoint || new URL(endpoint).hostname !== "127.0.0.1" ||
        bucket !== "creator-minio-ci" || process.env.STORAGE_FORCE_PATH_STYLE !== "true") {
      throw new Error("CREATOR_MINIO_DISPOSABLE_LOOPBACK_GUARD");
    }
    s3 = new S3Client({
      endpoint, region: process.env.STORAGE_REGION ?? "us-east-1",
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.STORAGE_ACCESS_KEY_ID ?? "",
        secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY ?? "",
      },
    });
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  }, 30_000);

  it("conditionally creates one immutable staged artifact and refuses overwrite", async () => {
    const key = creatorArtifactStageKey({
      workspaceId: 7, creatorProjectId: 11, generationId: 801,
      provider: "google-veo", providerJobId: "disposable-minio-job-801",
      checksumSha256: digest, extension: "mp4",
    });
    await storagePutCreatorStagedObject(key, payload, "video/mp4");
    await expect(storageVerifySha256(key, payload.length, digest)).resolves.toBeUndefined();
    await expect(storagePutCreatorStagedObject(key, payload, "video/mp4"))
      .rejects.toMatchObject({ name: "PreconditionFailed" });
    const tampered = Buffer.from(payload);
    tampered[0] ^= 1;
    await expect(storagePutCreatorStagedObject(key, tampered, "video/mp4"))
      .rejects.toThrow("CREATOR_STAGED_STORAGE_CHECKSUM_INVALID");
    await expect(storageVerifySha256(key, payload.length, digest)).resolves.toBeUndefined();
  });

  it("uploads, inventories and verifies real ranged S3 bytes before reporting quarantined evidence", async () => {
    const identity = scope(17);
    const key = await putFor(identity);
    expect(key).toMatch(/^creator\/7\/11\/renders\/timeline-13\/export-17_[0-9a-f]{8}\.mp4$/);
    expect(await storageListCreatorRenderObjects(identity)).toEqual([{ key, sizeBytes: payload.length }]);
    await expect(storageVerifySha256(key, payload.length, digest)).resolves.toBeUndefined();
    const result = await inspectQuarantinedCreatorRender(identity, {
      dbProvider: dbProvider(assetRow(identity, key)),
    });
    expect(result).toMatchObject({
      outcome: "VERIFIED_BUT_QUARANTINED", verifiedAssetId: 23,
      autoRetry: false, finalMaster: false, publishApproved: false,
    });
  });

  it("detects same-length byte corruption after persistence; never promotes the artifact", async () => {
    const identity = scope(18);
    const key = await putFor(identity);
    const corrupted = Buffer.from(payload);
    corrupted[0] ^= 1;
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: corrupted }));
    await expect(storageVerifySha256(key, payload.length, digest))
      .rejects.toThrow("CREATOR_STORAGE_READBACK_CHECKSUM_MISMATCH");
    const result = await inspectQuarantinedCreatorRender(identity, {
      dbProvider: dbProvider(assetRow(identity, key)),
    });
    expect(result).toMatchObject({
      outcome: "STORED_BYTES_UNVERIFIED", verifiedAssetId: null, autoRetry: false,
    });
  });

  it("reports persisted metadata drift when the object is missing", async () => {
    const identity = scope(19);
    const missingKey = "creator/7/11/renders/timeline-13/export-19_a0b1c2d3.mp4";
    const result = await inspectQuarantinedCreatorRender(identity, {
      dbProvider: dbProvider(assetRow(identity, missingKey)),
    });
    expect(result).toMatchObject({ outcome: "METADATA_DRIFT", observedObjects: 0, autoRetry: false });
  });

  it("leaves unfinalized orphan objects unverified without trusting S3 existence", async () => {
    const identity = scope(20);
    const key = await putFor(identity);
    const orphan = {
      ...assetRow(identity, key),
      exportAssetId: null, exportChecksum: null,
      claimAssetId: null, claimChecksum: null,
      assetId: null, assetType: null, assetImmutable: null,
      assetKey: null, assetSize: null, assetChecksum: null,
    };
    const result = await inspectQuarantinedCreatorRender(identity, {
      dbProvider: dbProvider(orphan),
    });
    expect(result).toMatchObject({ outcome: "UNVERIFIED_ORPHAN", observedObjects: 1, autoRetry: false });
  });

  it("rejects cross-tenant objects and export-ID prefix collisions", async () => {
    const identity = scope(21);
    const wrongTenant = "creator/8/11/renders/timeline-13/export-21_a0b1c2d3.mp4";
    const prefixCollision = "creator/7/11/renders/timeline-13/export-210_a0b1c2d3.mp4";
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: wrongTenant, Body: payload }));
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: prefixCollision, Body: payload }));
    expect(await storageListCreatorRenderObjects(identity)).toEqual([]);
    const result = await inspectQuarantinedCreatorRender(identity, {
      dbProvider: dbProvider(assetRow(identity, wrongTenant)),
    });
    expect(result).toMatchObject({ outcome: "METADATA_DRIFT", observedObjects: 0 });
  });

  it("rejects an actual paginated MinIO listing instead of certifying incomplete inventory", async () => {
    const identity = scope(22);
    await putFor(identity);
    await putFor(identity);
    await expect(storageListCreatorRenderObjects(identity, 1))
      .rejects.toThrow("CREATOR_RENDER_INVENTORY_TRUNCATED");
  });

  it("detects a mismatched persisted byte count without trusting S3 listing metadata", async () => {
    const identity = scope(23);
    const key = await putFor(identity);
    const result = await inspectQuarantinedCreatorRender(identity, {
      dbProvider: dbProvider(assetRow(identity, key, payload.length + 1)),
    });
    expect(result).toMatchObject({ outcome: "METADATA_DRIFT", verifiedAssetId: null, autoRetry: false });
  });
});
