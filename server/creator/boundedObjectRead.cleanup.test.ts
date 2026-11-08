import { describe, expect, it, vi } from "vitest";
import { readExactRangedObject } from "./boundedObjectRead";

function pendingBody(onCancel: () => void): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(Uint8Array.from([1, 2, 3])); },
    cancel() { onCancel(); },
  });
}

describe("Creator S3 invalid 206 response cleanup", () => {
  it("cancels a response whose total object size changed after listing", async () => {
    const onCancel = vi.fn();
    const body = pendingBody(onCancel);
    await expect(readExactRangedObject(body, 3, "bytes 0-2/4", 3))
      .rejects.toThrow("CREATOR_CHECKSUM_RANGE_NOT_HONORED");
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("cancels a response with a contradictory Content-Length", async () => {
    const onCancel = vi.fn();
    await expect(readExactRangedObject(pendingBody(onCancel), 3, "bytes 0-2/3", 4))
      .rejects.toThrow("CREATOR_CHECKSUM_RANGE_NOT_HONORED");
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("cancels a malformed range without acquiring a reader or reading bytes", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const getReader = vi.fn(() => { throw new Error("UNEXPECTED_BODY_READ"); });
    const body = { cancel, getReader } as unknown as ReadableStream<Uint8Array>;
    await expect(readExactRangedObject(body, 3, "bytes 1-3/4", 3))
      .rejects.toThrow("CREATOR_CHECKSUM_RANGE_NOT_HONORED");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(getReader).not.toHaveBeenCalled();
  });

  it("preserves the range error when cancellation itself fails", async () => {
    const cancel = vi.fn().mockRejectedValue(new Error("TRANSPORT_CANCEL_FAILED"));
    const body = { cancel } as unknown as ReadableStream<Uint8Array>;
    await expect(readExactRangedObject(body, 3, "bytes 0-2/9", 3))
      .rejects.toThrow("CREATOR_CHECKSUM_RANGE_NOT_HONORED");
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("does not attempt stream cancellation when requested size is invalid", async () => {
    const cancel = vi.fn();
    const body = { cancel } as unknown as ReadableStream<Uint8Array>;
    await expect(readExactRangedObject(body, 0, undefined))
      .rejects.toThrow("CREATOR_CHECKSUM_SIZE_OUT_OF_RANGE");
    expect(cancel).not.toHaveBeenCalled();
  });
});
