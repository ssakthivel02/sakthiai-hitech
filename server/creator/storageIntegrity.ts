import { createHash } from "node:crypto";

/** The renderer already caps an output at 1 GiB; storage readback may not buffer it. */
export const CREATOR_STORED_MEDIA_MAX_BYTES = 1024 * 1024 * 1024;

export type CreatorStoredObjectEvidence = {
  stream: ReadableStream<Uint8Array>;
  statusCode: number | undefined;
  contentRange: string | undefined;
  contentLength: number | undefined;
  expectedSize: number;
  expectedSha256: string;
};

/**
 * Verify the exact bytes uploaded to object storage before any Creator asset or
 * export is marked successful. Requires HTTP 206 and a complete bounded range;
 * never trusts an ETag, an unverified HEAD response, or a signed URL alone.
 * The stream is consumed incrementally rather than buffering another 1 GiB.
 */
export async function assertCreatorStoredObjectIntegrity(input: CreatorStoredObjectEvidence): Promise<{
  byteSize: number;
  checksumSha256: string;
}> {
  const { expectedSize, expectedSha256, stream } = input;
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 1 || expectedSize > CREATOR_STORED_MEDIA_MAX_BYTES ||
      !/^[0-9a-f]{64}$/.test(expectedSha256)) {
    throw new Error("CREATOR_STORAGE_EVIDENCE_INVALID");
  }
  const exactRange = `bytes 0-${expectedSize - 1}/${expectedSize}`;
  if (input.statusCode !== 206 || input.contentRange !== exactRange || input.contentLength !== expectedSize) {
    try { await stream.cancel("CREATOR_STORAGE_RANGE_NOT_HONORED"); } catch { /* keep contract failure */ }
    throw new Error("CREATOR_STORAGE_RANGE_NOT_HONORED");
  }
  const reader = stream.getReader();
  const hash = createHash("sha256");
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array) || !value.byteLength || received + value.byteLength > expectedSize) {
        throw new Error("CREATOR_STORAGE_STREAM_EXCEEDED_EXPECTED_SIZE");
      }
      received += value.byteLength;
      hash.update(value);
    }
    if (received !== expectedSize) throw new Error("CREATOR_STORAGE_STREAM_TRUNCATED");
    const checksumSha256 = hash.digest("hex");
    if (checksumSha256 !== expectedSha256) throw new Error("CREATOR_STORAGE_READBACK_CHECKSUM_MISMATCH");
    return { byteSize: received, checksumSha256 };
  } catch (error) {
    try { await reader.cancel("CREATOR_STORAGE_READBACK_FAILED"); } catch { /* preserve primary failure */ }
    throw error;
  } finally {
    reader.releaseLock();
  }
}
