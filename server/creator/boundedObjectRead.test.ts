import { describe, expect, it } from "vitest";
import { CREATOR_CHECKSUM_MAX_BYTES, readExactRangedObject } from "./boundedObjectRead";

function response(chunks: Uint8Array[], close = true): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      if (close) controller.close();
    },
  });
}

describe("Creator checksum range safety", () => {
  it("accepts exactly ranged bytes", async () => {
    const result = await readExactRangedObject(response([Uint8Array.from([1, 2]), Uint8Array.from([3])]), 3, "bytes 0-2/3", 3);
    expect(Array.from(result)).toEqual([1, 2, 3]);
  });
  it("rejects a backend ignoring Range before consuming any bytes", async () => {
    let consumed = false;
    const body = new ReadableStream<Uint8Array>({ pull() { consumed = true; } });
    await expect(readExactRangedObject(body, 3, undefined, 999999999)).rejects.toThrow("CREATOR_CHECKSUM_RANGE_NOT_HONORED");
    expect(consumed).toBe(false);
  });
  it("rejects a larger object after inventory (Content-Range total changed)", async () => {
    await expect(readExactRangedObject(response([new Uint8Array(4)]), 3, "bytes 0-2/4", 3))
      .rejects.toThrow("CREATOR_CHECKSUM_RANGE_NOT_HONORED");
  });
  it("rejects a smaller object after inventory", async () => {
    await expect(readExactRangedObject(response([new Uint8Array(2)]), 3, "bytes 0-1/2", 2))
      .rejects.toThrow("CREATOR_CHECKSUM_RANGE_NOT_HONORED");
  });
  it("rejects inconsistent Content-Length", async () => {
    await expect(readExactRangedObject(response([new Uint8Array(3)]), 3, "bytes 0-2/3", 4))
      .rejects.toThrow("CREATOR_CHECKSUM_RANGE_NOT_HONORED");
  });
  it("stops streaming immediately when actual bytes exceed the declared range", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(4)); },
      cancel() { cancelled = true; },
    });
    await expect(readExactRangedObject(body, 3, "bytes 0-2/3", 3))
      .rejects.toThrow("CREATOR_CHECKSUM_READ_LIMIT_EXCEEDED");
    expect(cancelled).toBe(true);
  });
  it("rejects truncated ranged bodies", async () => {
    await expect(readExactRangedObject(response([new Uint8Array(2)]), 3, "bytes 0-2/3", 3))
      .rejects.toThrow("CREATOR_CHECKSUM_TRUNCATED_READ");
  });
  it("rejects zero, negative, unsafe and above-cap object sizes", async () => {
    for (const size of [0, -1, Number.MAX_SAFE_INTEGER + 1, CREATOR_CHECKSUM_MAX_BYTES + 1]) {
      await expect(readExactRangedObject(response([]), size, undefined))
        .rejects.toThrow("CREATOR_CHECKSUM_SIZE_OUT_OF_RANGE");
    }
  });
  it("rejects malformed and nonzero-start range headers", async () => {
    for (const header of ["bytes 1-3/4", "bytes */3", "bytes 0-2/*", "bytes 0-2/999"]) {
      await expect(readExactRangedObject(response([new Uint8Array(3)]), 3, header))
        .rejects.toThrow("CREATOR_CHECKSUM_RANGE_NOT_HONORED");
    }
  });
});
