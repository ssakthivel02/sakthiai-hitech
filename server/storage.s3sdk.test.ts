import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Exercise the real AWS S3 SDK transport with a disposable, loopback-only S3
 * protocol endpoint. This is not live S3 certification or a paid provider call.
 */
const storageEnv = vi.hoisted(() => ({
  storageBucket: "creator-loopback-test",
  storageRegion: "us-east-1",
  storageEndpoint: "",
  storageForcePathStyle: true,
  storageAccessKeyId: "local-test-only",
  storageSecretAccessKey: "local-test-only",
}));
vi.mock("./_core/env", () => ({ ENV: storageEnv }));

import { storageListCreatorRenderObjects, storagePut, storageVerifySha256 } from "./storage";

type ResponseMode = "correct" | "ignore-range" | "corrupt" | "wrong-range";
const objects = new Map<string, Buffer>();
const requests: Array<{ method: string; key: string; range?: string }> = [];
let mode: ResponseMode = "correct";
let listTruncated = false;
let server: Server;

function objectKey(pathname: string): string {
  const prefix = `/${storageEnv.storageBucket}/`;
  if (!pathname.startsWith(prefix)) throw new Error("Unexpected test bucket");
  return decodeURIComponent(pathname.slice(prefix.length));
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
      // Real ListObjectsV2Command calls the bucket root with list-type=2.
      if (req.method === "GET" && requestUrl.searchParams.get("list-type") === "2") {
        const prefix = requestUrl.searchParams.get("prefix") ?? "";
        const matching = [...objects.entries()].filter(([key]) => key.startsWith(prefix));
        const xml = [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">',
          '<Name>creator-loopback-test</Name>',
          '<IsTruncated>' + String(listTruncated) + '</IsTruncated>',
          ...matching.map(([key, data]) => '<Contents><Key>' + key + '</Key><Size>' + data.length + '</Size></Contents>'),
          ...(listTruncated ? ['<NextContinuationToken>synthetic-next-page</NextContinuationToken>'] : []),
          '</ListBucketResult>',
        ].join("");
        requests.push({ method: "LIST", key: prefix });
        res.writeHead(200, { "Content-Type": "application/xml", "Content-Length": String(Buffer.byteLength(xml)) });
        res.end(xml);
        return;
      }
      const key = objectKey(requestUrl.pathname);
      requests.push({ method: req.method ?? "", key, range: req.headers.range });
      if (req.method === "PUT") {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        objects.set(key, Buffer.concat(chunks));
        res.writeHead(200, { ETag: '"local-test-object"', "Content-Length": "0" });
        res.end();
        return;
      }
      if (req.method === "GET") {
        const original = objects.get(key);
        if (!original) { res.writeHead(404); res.end(); return; }
        const requestedRange = `bytes=0-${original.length - 1}`;
        if (req.headers.range !== requestedRange) { res.writeHead(416); res.end(); return; }
        const data = Buffer.from(original);
        if (mode === "corrupt") data[0] ^= 1;
        if (mode === "ignore-range") {
          res.writeHead(200, { "Content-Length": String(data.length), "Content-Type": "application/octet-stream" });
        } else {
          const contentRange = mode === "wrong-range"
            ? `bytes 0-${data.length - 1}/${data.length + 1}`
            : `bytes 0-${data.length - 1}/${data.length}`;
          res.writeHead(206, {
            "Content-Range": contentRange,
            "Content-Length": String(data.length),
            "Content-Type": "application/octet-stream",
          });
        }
        res.end(data);
        return;
      }
      res.writeHead(405); res.end();
    } catch {
      res.writeHead(500); res.end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address() as AddressInfo;
  storageEnv.storageEndpoint = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

beforeEach(() => {
  objects.clear();
  requests.length = 0;
  mode = "correct";
  listTruncated = false;
});

const payload = Buffer.from("SakthiAI Murugan test: வேல் முருகா / source-verified bytes", "utf8");
const digest = createHash("sha256").update(payload).digest("hex");

async function upload(): Promise<string> {
  const stored = await storagePut("creator/1/2/renders/loopback.mp4", payload, "video/mp4");
  expect(stored.key).toMatch(/^creator\/1\/2\/renders\/loopback_[0-9a-f]{8}\.mp4$/);
  return stored.key;
}

describe("Creator S3 SDK upload/readback against disposable HTTP endpoint", () => {
  it("issues a real SDK PUT followed by bounded GET and verifies persisted SHA-256", async () => {
    const key = await upload();
    await expect(storageVerifySha256(key, payload.length, digest)).resolves.toBeUndefined();
    expect(requests.map(r => r.method)).toEqual(["PUT", "GET"]);
    expect(requests[1]).toEqual({ method: "GET", key, range: `bytes=0-${payload.length - 1}` });
    expect(objects.get(key)).toEqual(payload);
  });

  it("fails closed when an S3-compatible endpoint ignores Range and returns HTTP 200", async () => {
    const key = await upload();
    mode = "ignore-range";
    await expect(storageVerifySha256(key, payload.length, digest)).rejects.toThrow("CREATOR_STORAGE_RANGE_NOT_HONORED");
  });

  it("fails closed when a 206 response returns corrupted bytes", async () => {
    const key = await upload();
    mode = "corrupt";
    await expect(storageVerifySha256(key, payload.length, digest)).rejects.toThrow("CREATOR_STORAGE_READBACK_CHECKSUM_MISMATCH");
  });

  it("fails closed when Content-Range claims a different total object size", async () => {
    const key = await upload();
    mode = "wrong-range";
    await expect(storageVerifySha256(key, payload.length, digest)).rejects.toThrow("CREATOR_STORAGE_RANGE_NOT_HONORED");
  });

  it("rejects impossible evidence before issuing any GET", async () => {
    const key = await upload();
    await expect(storageVerifySha256(key, 0, digest)).rejects.toThrow("CREATOR_STORAGE_EVIDENCE_INVALID");
    await expect(storageVerifySha256(key, payload.length, "not-a-checksum")).rejects.toThrow("CREATOR_STORAGE_EVIDENCE_INVALID");
    expect(requests.map(r => r.method)).toEqual(["PUT"]);
  });
});


describe("Creator render inventory via real S3 SDK against loopback endpoint", () => {
  const scope = { workspaceId: 7, creatorProjectId: 11, timelineId: 13, exportId: 17 };
  const valid = "creator/7/11/renders/timeline-13/export-17_a0b1c2d3.mp4";

  it("lists only the exact scoped export and verifies its bytes with the same SDK", async () => {
    objects.set(valid, Buffer.from(payload));
    // S3 Prefix=export-17 also returns export-170; filter by exact identity.
    objects.set("creator/7/11/renders/timeline-13/export-170_a0b1c2d3.mp4", Buffer.from(payload));
    objects.set("creator/8/11/renders/timeline-13/export-17_a0b1c2d3.mp4", Buffer.from(payload));
    const inventory = await storageListCreatorRenderObjects(scope);
    expect(inventory).toEqual([{ key: valid, sizeBytes: payload.length }]);
    await expect(storageVerifySha256(valid, payload.length, digest)).resolves.toBeUndefined();
    expect(requests.map(request => request.method)).toEqual(["LIST", "GET"]);
  });

  it("rejects a truncated inventory rather than declaring an orphan absent", async () => {
    objects.set(valid, Buffer.from(payload));
    listTruncated = true;
    await expect(storageListCreatorRenderObjects(scope)).rejects.toThrow("CREATOR_RENDER_INVENTORY_TRUNCATED");
    expect(requests.map(request => request.method)).toEqual(["LIST"]);
  });
});
