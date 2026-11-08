import { beforeEach, describe, expect, it, vi } from "vitest";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { CREATOR_CHECKSUM_MAX_BYTES } from "./creator/boundedObjectRead";
import { storageReadExactRange } from "./storage";

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));

// Exercise the actual storage adapter, including GetObjectCommand construction.
// Only the transport is replaced; no network, object writes or paid calls occur.
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class { send = sendMock; },
  GetObjectCommand: class { constructor(public input: Record<string, unknown>) {} },
  PutObjectCommand: class { constructor(public input: Record<string, unknown>) {} },
  DeleteObjectCommand: class { constructor(public input: Record<string, unknown>) {} },
  ListObjectsV2Command: class { constructor(public input: Record<string, unknown>) {} },
}));
vi.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl: vi.fn() }));
vi.mock("./_core/env", () => ({ ENV: {
  storageBucket: "creator-range-test", storageRegion: "us-east-1",
  storageEndpoint: "http://localhost:9000", storageForcePathStyle: true,
  storageAccessKeyId: "test-only", storageSecretAccessKey: "test-only",
} }));

const KEY = "creator/7/10/audio-master/master.wav";
function bytesStream(chunks: Uint8Array[], onCancel?: () => void): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      if (!onCancel) controller.close();
    },
    cancel() { onCancel?.(); },
  });
}
function s3Response(options: {
  status?: number;
  contentRange?: string;
  contentLength?: number;
  chunks?: Uint8Array[];
  onStream?: () => void;
  onCancel?: () => void;
}) {
  return {
    $metadata: { httpStatusCode: options.status ?? 206 },
    ContentRange: options.contentRange,
    ContentLength: options.contentLength,
    Body: { transformToWebStream: () => {
      options.onStream?.();
      return bytesStream(options.chunks ?? [], options.onCancel);
    } },
  };
}

describe("Creator S3 exact-range adapter: command and HTTP response contract", () => {
  beforeEach(() => sendMock.mockReset());

  it("issues an exact S3 Range request and accepts a genuine 206 partial response", async () => {
    sendMock.mockResolvedValue(s3Response({
      status: 206, contentRange: "bytes 0-3/4", contentLength: 4,
      chunks: [Uint8Array.from([1, 2]), Uint8Array.from([3, 4])],
    }));
    const result = await storageReadExactRange(`/${KEY}`, 4);
    expect(Array.from(result)).toEqual([1, 2, 3, 4]);
    expect(sendMock).toHaveBeenCalledTimes(1);
    const command = sendMock.mock.calls[0][0] as GetObjectCommand;
    expect(command).toBeInstanceOf(GetObjectCommand);
    expect(command.input).toEqual({
      Bucket: "creator-range-test", Key: KEY, Range: "bytes=0-3",
    });
  });

  it("rejects HTTP 200 even when a backend forges valid Content-Range headers", async () => {
    const onStream = vi.fn();
    sendMock.mockResolvedValue(s3Response({
      status: 200, contentRange: "bytes 0-3/4", contentLength: 4,
      chunks: [Uint8Array.from([1, 2, 3, 4])], onStream,
    }));
    await expect(storageReadExactRange(KEY, 4)).rejects.toThrow("CREATOR_CHECKSUM_RANGE_NOT_HONORED");
    expect(onStream).not.toHaveBeenCalled();
  });

  it("rejects a 200 full-object response with no Content-Range before reading", async () => {
    const onStream = vi.fn();
    sendMock.mockResolvedValue(s3Response({ status: 200, contentLength: 900_000_000, onStream }));
    await expect(storageReadExactRange(KEY, 4)).rejects.toThrow("CREATOR_CHECKSUM_RANGE_NOT_HONORED");
    expect(onStream).not.toHaveBeenCalled();
  });

  it("rejects a 206 response with missing or contradictory range metadata", async () => {
    for (const contentRange of [undefined, "bytes 0-3/5", "bytes 1-4/5"]) {
      sendMock.mockResolvedValue(s3Response({
        status: 206, contentRange, contentLength: 4,
        chunks: [Uint8Array.from([1, 2, 3, 4])],
      }));
      await expect(storageReadExactRange(KEY, 4)).rejects.toThrow("CREATOR_CHECKSUM_RANGE_NOT_HONORED");
    }
    expect(sendMock).toHaveBeenCalledTimes(3);
  });

  it("rejects a missing body without claiming checksum verification", async () => {
    sendMock.mockResolvedValue({ $metadata: { httpStatusCode: 206 }, ContentRange: "bytes 0-3/4" });
    await expect(storageReadExactRange(KEY, 4)).rejects.toThrow("CREATOR_CHECKSUM_MISSING_BODY");
  });

  it("rejects a lying stream that exceeds the declared range and cancels it", async () => {
    const onCancel = vi.fn();
    sendMock.mockResolvedValue(s3Response({
      status: 206, contentRange: "bytes 0-3/4", contentLength: 4,
      chunks: [new Uint8Array(5)], onCancel,
    }));
    await expect(storageReadExactRange(KEY, 4)).rejects.toThrow("CREATOR_CHECKSUM_READ_LIMIT_EXCEEDED");
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("rejects truncated 206 responses", async () => {
    sendMock.mockResolvedValue(s3Response({
      status: 206, contentRange: "bytes 0-3/4", contentLength: 4,
      chunks: [Uint8Array.from([1, 2])],
    }));
    await expect(storageReadExactRange(KEY, 4)).rejects.toThrow("CREATOR_CHECKSUM_TRUNCATED_READ");
  });

  it("rejects invalid or oversized requested lengths before sending an S3 command", async () => {
    for (const invalid of [0, -1, 1.5, CREATOR_CHECKSUM_MAX_BYTES + 1, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(storageReadExactRange(KEY, invalid)).rejects.toThrow("CREATOR_CHECKSUM_SIZE_OUT_OF_RANGE");
    }
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("propagates transport failure without inventing a verified result", async () => {
    sendMock.mockRejectedValue(new Error("S3_RANGE_TRANSPORT_FAILED"));
    await expect(storageReadExactRange(KEY, 4)).rejects.toThrow("S3_RANGE_TRANSPORT_FAILED");
  });
});
