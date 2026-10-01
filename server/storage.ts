import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
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

export async function storageDelete(relKey: string): Promise<void> {
  const { client: s3, bucket } = getStorageConfig();
  const key = normalizeKey(relKey);
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

type StorageProbeDependencies = {
  put?: typeof storagePut;
  read?: typeof storageRead;
  delete?: typeof storageDelete;
};

export async function storageRoundTripProbe(
  deps: StorageProbeDependencies = {},
): Promise<{ pass: boolean; detail: string }> {
  const payload = Buffer.from(`sakthiai-creator-storage-probe:${crypto.randomUUID()}`, "utf-8");
  const put = deps.put ?? storagePut;
  const read = deps.read ?? storageRead;
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
    const loaded = Buffer.from(await read(stored.key));
    if (!loaded.equals(payload)) {
      primaryFailure = { pass: false, detail: "Storage write/read round-trip returned different bytes." };
    }
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
  return { pass: true, detail: "Storage write/read/delete round-trip succeeded and canary bytes matched." };
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
