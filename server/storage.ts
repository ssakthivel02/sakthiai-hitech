import { createHash } from "node:crypto";
import { readExactRangedObject, CREATOR_CHECKSUM_MAX_BYTES } from "./creator/boundedObjectRead";
import { assertCreatorStoredObjectIntegrity, CREATOR_STORED_MEDIA_MAX_BYTES } from "./creator/storageIntegrity";
import { DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { ENV } from "./_core/env";

let client: S3Client | null = null;

function getStorageConfig() {
  if (!ENV.storageBucket) {
    throw new Error("Storage config missing: set STORAGE_BUCKET");
  }

  if (!client) {
    const credentials = ENV.storageAccessKeyId && ENV.storageSecretAccessKey
      ? {
          accessKeyId: ENV.storageAccessKeyId,
          secretAccessKey: ENV.storageSecretAccessKey,
        }
      : undefined;

    client = new S3Client({
      region: ENV.storageRegion || "auto",
      endpoint: ENV.storageEndpoint || undefined,
      forcePathStyle: ENV.storageForcePathStyle,
      credentials,
    });
  }

  return { client, bucket: ENV.storageBucket };
}

function normalizeKey(relKey: string): string {
  return relKey.replace(/^\/+/, "");
}

function appendHashSuffix(relKey: string): string {
  const hash = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  const lastDot = relKey.lastIndexOf(".");
  if (lastDot === -1) return `${relKey}_${hash}`;
  return `${relKey.slice(0, lastDot)}_${hash}${relKey.slice(lastDot)}`;
}

export async function storagePut(
  relKey: string,
  data: Buffer | Uint8Array | string,
  contentType = "application/octet-stream",
): Promise<{ key: string; url: string }> {
  const { client: s3, bucket } = getStorageConfig();
  const key = appendHashSuffix(normalizeKey(relKey));

  const body = typeof data === "string" ? Buffer.from(data) : data;
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: contentType,
  }));

  return { key, url: `/api/storage/${key}` };
}

export async function storageGet(relKey: string): Promise<{ key: string; url: string }> {
  const key = normalizeKey(relKey);
  return { key, url: `/api/storage/${key}` };
}

export async function storageRead(relKey: string): Promise<Uint8Array> {
  const { client: s3, bucket } = getStorageConfig();
  const key = normalizeKey(relKey);
  const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!result.Body) throw new Error("Storage object body missing");
  return result.Body.transformToByteArray();
}

/** Exact-size, bounded S3 GET. Range is required and the stream is capped even if
 * a backend lies about Content-Length or ignores the requested range. */
export async function storageReadExactRange(relKey: string, expectedSize: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 1 || expectedSize > CREATOR_CHECKSUM_MAX_BYTES) {
    throw new Error("CREATOR_CHECKSUM_SIZE_OUT_OF_RANGE");
  }
  const { client: s3, bucket } = getStorageConfig();
  const key = normalizeKey(relKey);
  const result = await s3.send(new GetObjectCommand({
    Bucket: bucket,
    Key: key,
    Range: `bytes=0-${expectedSize - 1}`,
  }));
  if (!result.Body) throw new Error("CREATOR_CHECKSUM_MISSING_BODY");
  // Require HTTP 206 plus exact Content-Range; reject even forged range headers on HTTP 200.
  if (result.$metadata?.httpStatusCode !== 206 || !result.ContentRange) {
    // A noncompliant backend may still return a large streaming body. Cancel it
    // without reading any bytes, and preserve the original contract error even
    // when the SDK stream cannot be converted or cancelled.
    try {
      await result.Body.transformToWebStream().cancel("CREATOR_CHECKSUM_RANGE_NOT_HONORED");
    } catch {
      // Cleanup is best-effort; never turn a rejected range into success.
    }
    throw new Error("CREATOR_CHECKSUM_RANGE_NOT_HONORED");
  }
  return readExactRangedObject(result.Body.transformToWebStream(), expectedSize, result.ContentRange, result.ContentLength);
}

/** Verify persisted media bytes, not only the PutObject response or ETag. */
export async function storageVerifySha256(relKey: string, expectedSize: number, expectedSha256: string): Promise<void> {
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 1 || expectedSize > CREATOR_STORED_MEDIA_MAX_BYTES ||
      !/^[0-9a-f]{64}$/.test(expectedSha256)) throw new Error("CREATOR_STORAGE_EVIDENCE_INVALID");
  const { client: s3, bucket } = getStorageConfig();
  const result = await s3.send(new GetObjectCommand({
    Bucket: bucket, Key: normalizeKey(relKey), Range: `bytes=0-${expectedSize - 1}`,
  }), { abortSignal: AbortSignal.timeout(120_000) });
  if (!result.Body) throw new Error("CREATOR_STORAGE_READBACK_MISSING_BODY");
  await assertCreatorStoredObjectIntegrity({
    stream: result.Body.transformToWebStream(),
    statusCode: result.$metadata?.httpStatusCode,
    contentRange: result.ContentRange,
    contentLength: result.ContentLength,
    expectedSize, expectedSha256,
  });
}

export async function storageDelete(relKey: string): Promise<void> {
  const { client: s3, bucket } = getStorageConfig();
  const key = normalizeKey(relKey);
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

type StorageProbeDependencies = {
  put?: typeof storagePut;
  /** Optional legacy test seam; production must use the bounded range verifier. */
  read?: typeof storageRead;
  verify?: typeof storageVerifySha256;
  delete?: typeof storageDelete;
};

export async function storageRoundTripProbe(
  deps: StorageProbeDependencies = {},
): Promise<{ pass: boolean; detail: string }> {
  const payload = Buffer.from(`sakthiai-creator-storage-probe:${crypto.randomUUID()}`, "utf-8");
  const put = deps.put ?? storagePut;
  // Runtime readiness must exercise the SAME HTTP 206 / SHA-256 contract as
  // Creator artifact persistence. An ordinary full-object GET is insufficient.
  // The injected read seam is retained only for existing isolated unit tests.
  const verify = deps.verify ?? (deps.read
    ? async (key: string, size: number, checksum: string) => {
        const loaded = Buffer.from(await deps.read!(key));
        if (loaded.byteLength !== size || createHash("sha256").update(loaded).digest("hex") !== checksum) {
          throw new Error("CREATOR_STORAGE_PROBE_MISMATCH");
        }
      }
    : storageVerifySha256);
  const remove = deps.delete ?? storageDelete;
  let key: string | undefined;
  let primaryFailure: { pass: false; detail: string } | null = null;

  try {
    const stored = await put(
      "creator/runtime-probes/storage-canary.txt",
      payload,
      "text/plain; charset=utf-8",
    );
    key = stored.key;
    await verify(stored.key, payload.byteLength, createHash("sha256").update(payload).digest("hex"));
  } catch {
    primaryFailure = { pass: false, detail: "Storage write/read round-trip failed." };
  }

  if (key) {
    try {
      await remove(key);
    } catch {
      if (!primaryFailure) {
        return { pass: false, detail: "Storage delete verification failed." };
      }
    }
  }

  if (primaryFailure) return primaryFailure;
  return { pass: true, detail: "Storage write/verified-read/delete round-trip succeeded; canary SHA-256 matched." };
}

export async function storageGetSignedUrl(relKey: string): Promise<string> {
  const { client: s3, bucket } = getStorageConfig();
  const key = normalizeKey(relKey);
  return getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: bucket, Key: key }),
    { expiresIn: 300 },
  );
}

/** Bounded S3 listing for operator-only Creator reconciliation; no writes or deletion. */
export async function storageListPage(prefix: string, maxKeys = 100, continuationToken?: string): Promise<{
  objects: Array<{ key: string; sizeBytes: number; lastModified: Date | null }>;
  isTruncated: boolean;
  nextContinuationToken?: string;
}> {
  if (!new RegExp("^creator/[1-9][0-9]*/$").test(prefix)) throw new Error("CREATOR_INVENTORY_PREFIX_INVALID");
  if (!Number.isInteger(maxKeys) || maxKeys < 1 || maxKeys > 200) throw new Error("CREATOR_INVENTORY_LIMIT_INVALID");
  const { client: s3, bucket } = getStorageConfig();
  const result = await s3.send(new ListObjectsV2Command({
    Bucket: bucket,
    Prefix: prefix,
    MaxKeys: maxKeys,
    ContinuationToken: continuationToken,
  }));
  const objects = (result.Contents ?? []).map((item) => {
    if (!item.Key || !item.Key.startsWith(prefix) || !Number.isSafeInteger(item.Size) || item.Size! < 0) {
      throw new Error("CREATOR_INVENTORY_INVALID_STORAGE_OBJECT");
    }
    return { key: item.Key, sizeBytes: item.Size!, lastModified: item.LastModified ?? null };
  });
  if (result.IsTruncated && !result.NextContinuationToken) throw new Error("CREATOR_INVENTORY_INVALID_PAGE");
  return {
    objects,
    isTruncated: Boolean(result.IsTruncated),
    nextContinuationToken: result.NextContinuationToken,
  };
}
