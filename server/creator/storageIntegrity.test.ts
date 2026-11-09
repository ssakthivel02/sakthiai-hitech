import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assertCreatorStoredObjectIntegrity } from "./storageIntegrity";

const data = Buffer.from("creator-object-readback:வேல் முருகா", "utf8");
const sha = createHash("sha256").update(data).digest("hex");
function evidence(bytes: Uint8Array = data, overrides: Record<string, unknown> = {}) {
  return {
    stream: new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(bytes.subarray(0, 7));
      controller.enqueue(bytes.subarray(7));
      controller.close();
    } }),
    statusCode: 206, contentRange: `bytes 0-${data.length - 1}/${data.length}`,
    contentLength: data.length, expectedSize: data.length, expectedSha256: sha,
    ...overrides,
  };
}
describe("Creator stored-object readback", () => {
  it("streams and verifies exact object bytes", async () => {
    expect(await assertCreatorStoredObjectIntegrity(evidence())).toEqual({ byteSize: data.length, checksumSha256: sha });
  });
  it("rejects a corrupted object before export success", async () => {
    const changed = Buffer.from(data); changed[8] ^= 1;
    await expect(assertCreatorStoredObjectIntegrity(evidence(changed))).rejects.toThrow("CREATOR_STORAGE_READBACK_CHECKSUM_MISMATCH");
  });
  it("rejects ignored ranges even with matching bytes", async () => {
    await expect(assertCreatorStoredObjectIntegrity(evidence(data, { statusCode: 200 }))).rejects.toThrow("CREATOR_STORAGE_RANGE_NOT_HONORED");
  });
  it("rejects a truncated object", async () => {
    await expect(assertCreatorStoredObjectIntegrity(evidence(data.subarray(0, -1)))).rejects.toThrow("CREATOR_STORAGE_STREAM_TRUNCATED");
  });
  it("rejects an oversized stream", async () => {
    await expect(assertCreatorStoredObjectIntegrity(evidence(Buffer.concat([data, Buffer.from("x")])))).rejects.toThrow("CREATOR_STORAGE_STREAM_EXCEEDED_EXPECTED_SIZE");
  });
  it("rejects invalid size, checksum and range metadata", async () => {
    await expect(assertCreatorStoredObjectIntegrity(evidence(data, { expectedSize: 0 }))).rejects.toThrow("CREATOR_STORAGE_EVIDENCE_INVALID");
    await expect(assertCreatorStoredObjectIntegrity(evidence(data, { expectedSha256: "bad" }))).rejects.toThrow("CREATOR_STORAGE_EVIDENCE_INVALID");
    await expect(assertCreatorStoredObjectIntegrity(evidence(data, { contentRange: "bytes 0-1/2" }))).rejects.toThrow("CREATOR_STORAGE_RANGE_NOT_HONORED");
    await expect(assertCreatorStoredObjectIntegrity(evidence(data, { contentLength: data.length + 1 }))).rejects.toThrow("CREATOR_STORAGE_RANGE_NOT_HONORED");
  });
});
