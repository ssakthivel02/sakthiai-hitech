/** Strict, bounded reader for S3 ranged GET responses used by Creator reconciliation.
 * Reject a provider that ignores Range or changes the object's size after listing.
 * This module performs no storage writes or deletes.
 */
export const CREATOR_CHECKSUM_MAX_BYTES = 8 * 1024 * 1024;

export async function readExactRangedObject(
  stream: ReadableStream<Uint8Array>,
  expectedSize: number,
  contentRange: string | undefined,
  contentLength?: number,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 1 || expectedSize > CREATOR_CHECKSUM_MAX_BYTES) {
    throw new Error("CREATOR_CHECKSUM_SIZE_OUT_OF_RANGE");
  }
  // A 200 response with the full object is not acceptable, even if its headers
  // claim a small size. An exact 206 Content-Range is mandatory.
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange ?? "");
  if (!match || Number(match[1]) !== 0 || Number(match[2]) !== expectedSize - 1 ||
      Number(match[3]) !== expectedSize ||
      (contentLength !== undefined && contentLength !== expectedSize)) {
    // The SDK may already have opened a streaming HTTP response. Rejecting its
    // headers without cancellation can leave a connection and buffered body alive.
    // Do not acquire a reader or consume bytes from an untrusted response.
    try { await stream.cancel("CREATOR_CHECKSUM_RANGE_NOT_HONORED"); } catch {
      // Preserve the range-contract failure if transport cleanup itself fails.
    }
    throw new Error("CREATOR_CHECKSUM_RANGE_NOT_HONORED");
  }
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array) || received + value.byteLength > expectedSize) {
        throw new Error("CREATOR_CHECKSUM_READ_LIMIT_EXCEEDED");
      }
      received += value.byteLength;
      chunks.push(Buffer.from(value));
    }
    if (received !== expectedSize) throw new Error("CREATOR_CHECKSUM_TRUNCATED_READ");
    return Buffer.concat(chunks, received);
  } finally {
    // On a lying backend or concurrent object growth, stop the stream immediately.
    try { await reader.cancel(); } catch { /* preserve the original read error */ }
    reader.releaseLock();
  }
}
