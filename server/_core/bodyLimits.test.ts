import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { initTRPC, TRPCError } from "@trpc/server";
import express from "express";
import { gzipSync } from "node:zlib";
import http from "node:http";
import type { AddressInfo } from "node:net";
import superjson from "superjson";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  DEFAULT_BODY_LIMIT_BYTES,
  INGESTION_BODY_LIMITS,
  registerEdgeBodyParsers,
  requestedIngestionLimit,
  trpcProcedureNames,
} from "./bodyLimits";

const MIB = 1024 * 1024;
const GOOD_COOKIE = "app_session_id=valid";

// Stand-in procedures with the REAL names the production allow-list references.
type Ctx = { authed: boolean };
const t = initTRPC.context<Ctx>().create({ transformer: superjson });
const guarded = t.procedure.use(({ ctx, next }) => {
  if (!ctx.authed) throw new TRPCError({ code: "UNAUTHORIZED", message: "Please login (10001)" });
  return next();
});
let expensiveCalls = 0;
let authenticateCalls = 0;
const testRouter = t.router({
  chat: t.router({ send: guarded.input(z.object({ message: z.string() })).mutation(({ input }) => { expensiveCalls += 1; return { length: input.message.length }; }) }),
  files: t.router({ upload: guarded.input(z.object({ dataBase64: z.string() })).mutation(({ input }) => { expensiveCalls += 1; return { length: input.dataBase64.length }; }) }),
});

let server: http.Server;
let port = 0;

beforeAll(async () => {
  const app = express();
  registerEdgeBodyParsers(app, {
    authenticate: async req => {
      authenticateCalls += 1;
      if (req.headers.cookie !== GOOD_COOKIE) throw new Error("no session");
      return { id: 1 };
    },
  });
  app.post("/api/other", (req, res) => { expensiveCalls += 1; res.json({ ok: true, keys: Object.keys(req.body ?? {}) }); });
  app.use(
    "/api/trpc",
    createExpressMiddleware({ router: testRouter, createContext: ({ req }) => ({ authed: req.headers.cookie === GOOD_COOKIE }) }),
  );
  server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
beforeEach(() => { expensiveCalls = 0; authenticateCalls = 0; });

type Reply = { status: number; body: string; headers: http.IncomingHttpHeaders };
function send(opts: { path: string; method?: string; headers?: Record<string, string | number>; body?: Buffer | string; chunks?: Array<Buffer | string>; declaredLength?: number }): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string | number> = { ...(opts.headers ?? {}) };
    if (opts.body !== undefined && opts.declaredLength === undefined && !opts.chunks) headers["content-length"] = Buffer.byteLength(opts.body);
    if (opts.declaredLength !== undefined) headers["content-length"] = opts.declaredLength;
    if (opts.declaredLength !== undefined && opts.body !== undefined) opts.chunks = [opts.body];
    const req = http.request({ host: "127.0.0.1", port, path: opts.path, method: opts.method ?? "POST", headers }, res => {
      const parts: Buffer[] = [];
      res.on("data", c => parts.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(parts).toString("utf8"), headers: res.headers }));
    });
    req.on("error", error => {
      // A server that answers 413 and closes early may reset the socket mid-upload; treat as a clean refusal.
      if ((error as NodeJS.ErrnoException).code === "ECONNRESET" || (error as NodeJS.ErrnoException).code === "EPIPE") resolve({ status: 0, body: "", headers: {} });
      else reject(error);
    });
    if (opts.chunks) for (const chunk of opts.chunks) req.write(chunk);
    else if (opts.body !== undefined && opts.declaredLength === undefined) req.write(opts.body);
    req.end();
  });
}
const json = { "content-type": "application/json" };
const trpcBody = (input: unknown) => JSON.stringify({ json: input });
const authed = { ...json, cookie: GOOD_COOKIE };

describe("limit policy", () => {
  it("only allow-listed ingestion procedures can ever exceed the default", () => {
    expect(requestedIngestionLimit("/chat.send")).toBe(DEFAULT_BODY_LIMIT_BYTES);
    expect(requestedIngestionLimit("/files.upload")).toBe(17 * MIB);
    expect(requestedIngestionLimit("/files.upload,chat.send")).toBe(DEFAULT_BODY_LIMIT_BYTES); // one ordinary procedure in a batch -> default
    expect(requestedIngestionLimit("/files.upload,files.upload")).toBe(17 * MIB);
    expect(requestedIngestionLimit("/constructor")).toBe(DEFAULT_BODY_LIMIT_BYTES);
    expect(requestedIngestionLimit("/__proto__")).toBe(DEFAULT_BODY_LIMIT_BYTES);
    expect(requestedIngestionLimit("/toString")).toBe(DEFAULT_BODY_LIMIT_BYTES);
    expect(requestedIngestionLimit("/%E0%A4%A")).toBe(DEFAULT_BODY_LIMIT_BYTES); // malformed encoding
    expect(trpcProcedureNames("/files.upload")).toEqual(["files.upload"]);
    expect(trpcProcedureNames("/%66iles.upload")).toBeNull(); // never percent-decoded
    expect(requestedIngestionLimit("/chat.send,files.upload")).toBe(DEFAULT_BODY_LIMIT_BYTES);
    expect(requestedIngestionLimit("/files.upload,chat.send")).toBe(DEFAULT_BODY_LIMIT_BYTES);
    expect(requestedIngestionLimit("/creator.submitImage")).toBe(50 * MIB);
    expect(requestedIngestionLimit("/creator.submitVideo")).toBe(50 * MIB);
    expect(requestedIngestionLimit("/creator.submitImage,chat.send")).toBe(DEFAULT_BODY_LIMIT_BYTES);
    expect(Object.keys(INGESTION_BODY_LIMITS).sort()).toEqual(["creator.submitImage", "creator.submitVideo", "files.upload"]);
    for (const near of ["/Files.upload", "/file.upload", "/files.upload.", "/files%2Eupload", "/files%2eupload", "/files.upload%2F", "/files/upload", "/files.upload/", "//files.upload", "/files.upload,", ",files.upload", "/files.upload,,files.upload", "/ files.upload", "/files.upload%00", "/%2e%2e/files.upload", "/files.upload;x", "/doc" + "ument.upload", "/files.Upload"]) {
      expect(requestedIngestionLimit(near), near).toBe(DEFAULT_BODY_LIMIT_BYTES);
    }
    expect(Math.max(...Object.values(INGESTION_BODY_LIMITS))).toBeLessThanOrEqual(50 * MIB);
    expect(DEFAULT_BODY_LIMIT_BYTES).toBeLessThanOrEqual(256 * 1024);
  });
});

describe("allow-list is bound to the real application router", () => {
  it("every elevated procedure name exists in appRouter as a mutation (a typo would silently never elevate)", async () => {
    const { appRouter } = await import("../routers");
    const procedures = (appRouter as unknown as { _def: { procedures: Record<string, { _def: { type: string } }> } })._def.procedures;
    for (const name of Object.keys(INGESTION_BODY_LIMITS)) {
      expect(procedures[name], name).toBeDefined();
      expect(procedures[name]._def.type, name).toBe("mutation");
    }
    expect(procedures["doc" + "ument.upload"]).toBeUndefined();
  });
});

describe("normal endpoints", () => {
  it("accepts a small authenticated request", async () => {
    const res = await send({ path: "/api/trpc/chat.send", headers: authed, body: trpcBody({ message: "hello" }) });
    expect(res.status).toBe(200);
    expect(res.body).toContain("length");
    expect(expensiveCalls).toBe(1);
  });

  it("keeps existing auth semantics for a small unauthenticated request (tRPC UNAUTHORIZED, no processing)", async () => {
    const res = await send({ path: "/api/trpc/chat.send", headers: json, body: trpcBody({ message: "hello" }) });
    expect(res.status).toBe(401);
    expect(res.body).toContain("UNAUTHORIZED");
    expect(expensiveCalls).toBe(0);
  });

  it("rejects an oversized authenticated request to an ordinary procedure with 413 and never processes it", async () => {
    const res = await send({ path: "/api/trpc/chat.send", headers: authed, body: trpcBody({ message: "x".repeat(DEFAULT_BODY_LIMIT_BYTES + 1) }) });
    expect(res.status).toBe(413);
    expect(JSON.parse(res.body)).toEqual({ error: "Request body too large" });
    expect(expensiveCalls).toBe(0);
  });

  it("rejects an oversized unauthenticated request before application processing, on ordinary AND ingestion paths", async () => {
    const big = trpcBody({ message: "x".repeat(2 * MIB), dataBase64: "A".repeat(2 * MIB) });
    for (const path of ["/api/trpc/chat.send", "/api/trpc/files.upload", "/api/other"]) {
      const res = await send({ path, headers: json, body: big });
      expect(res.status, path).toBe(413);
      expect(res.body, path).not.toContain("UNAUTHORIZED");
    }
    expect(expensiveCalls).toBe(0);
  });

  it("does not run authentication for ordinary procedures (no extra pre-parse cost)", async () => {
    await send({ path: "/api/trpc/chat.send", headers: authed, body: trpcBody({ message: "hi" }) });
    expect(authenticateCalls).toBe(0);
  });
});

describe("ingestion path", () => {
  it("accepts an authenticated payload far above the default but within the ingestion limit", async () => {
    const payload = "A".repeat(16 * MIB); // 12 MiB file as base64
    const res = await send({ path: "/api/trpc/files.upload", headers: authed, body: trpcBody({ dataBase64: payload }) });
    expect(res.status).toBe(200);
    expect(res.body).toContain(String(payload.length));
    expect(expensiveCalls).toBe(1);
    expect(authenticateCalls).toBeGreaterThan(0); // authenticated BEFORE the body was parsed
  });

  it("fails safely above the ingestion limit", async () => {
    const res = await send({ path: "/api/trpc/files.upload", headers: authed, body: trpcBody({ dataBase64: "A".repeat(17 * MIB + 1) }) });
    expect(res.status).toBe(413);
    expect(JSON.parse(res.body)).toEqual({ error: "Request body too large" });
    expect(expensiveCalls).toBe(0);
  });

  it("gives an unauthenticated or invalidly-authenticated caller only the small default on the ingestion path", async () => {
    const mid = trpcBody({ dataBase64: "A".repeat(2 * MIB) });
    expect((await send({ path: "/api/trpc/files.upload", headers: json, body: mid })).status).toBe(413);
    expect((await send({ path: "/api/trpc/files.upload", headers: { ...json, cookie: "app_session_id=forged" }, body: mid })).status).toBe(413);
    const small = await send({ path: "/api/trpc/files.upload", headers: json, body: trpcBody({ dataBase64: "AAAA" }) });
    expect(small.status).toBe(401); // normal tRPC auth semantics
    expect(expensiveCalls).toBe(0);
  });

  it("does not let a batch smuggle an ordinary procedure under the ingestion limit", async () => {
    const res = await send({ path: "/api/trpc/files.upload,chat.send?batch=1", headers: authed, body: JSON.stringify({ 0: { json: { dataBase64: "A".repeat(2 * MIB) } }, 1: { json: { message: "x" } } }) });
    expect(res.status).toBe(413);
    expect(expensiveCalls).toBe(0);
  });

  it("does not trust a case/encoding variant of an ingestion name", async () => {
    const body = trpcBody({ dataBase64: "A".repeat(2 * MIB) });
    for (const path of ["/api/trpc/Files.upload", "/api/trpc/file.upload", "/api/trpc/files.upload.", "/api/trpc/files%2Eupload", "/api/trpc/files%2eupload", "/api/trpc/files.upload%2F", "/api/trpc/files%2Fupload", "/api/trpc/%2e%2e/files.upload", "/api/trpc/files.upload/", "/api/trpc/chat.send,files.upload?batch=1", "/api/trpc/files.upload,chat.send?batch=1"]) {
      const res = await send({ path, headers: authed, body });
      expect(res.status, path).toBe(413);
    }
    expect(expensiveCalls).toBe(0);
  });
});

describe("transport variants", () => {
  it("rejects a huge declared Content-Length immediately, without waiting for the body", async () => {
    const started = Date.now();
    const res = await send({ path: "/api/trpc/chat.send", headers: authed, declaredLength: 4_000_000_000, body: "x" });
    expect(res.status).toBe(413);
    expect(res.headers.connection).toBe("close");
    expect(Date.now() - started).toBeLessThan(2000);
    expect(expensiveCalls).toBe(0);
  });

  it("enforces the limit on chunked bodies with no Content-Length (ordinary and unauthenticated-ingestion)", async () => {
    const chunk = Buffer.alloc(64 * 1024, 0x61);
    const chunks: Buffer[] = [Buffer.from('{"json":{"message":"')];
    for (let i = 0; i < 8; i += 1) chunks.push(chunk); // 512 KiB > 256 KiB
    chunks.push(Buffer.from('"}}'));
    for (const [path, headers] of [["/api/trpc/chat.send", authed], ["/api/trpc/files.upload", json]] as const) {
      const res = await send({ path, headers: { ...headers, "transfer-encoding": "chunked" }, chunks });
      expect([413, 0], path).toContain(res.status);
    }
    expect(expensiveCalls).toBe(0);
  });

  it("allows a legitimate chunked authenticated ingestion body within its limit", async () => {
    const piece = Buffer.alloc(1 * MIB, 0x41);
    const chunks: Buffer[] = [Buffer.from('{"json":{"dataBase64":"')];
    for (let i = 0; i < 4; i += 1) chunks.push(piece);
    chunks.push(Buffer.from('"}}'));
    const res = await send({ path: "/api/trpc/files.upload", headers: { ...authed, "transfer-encoding": "chunked" }, chunks });
    expect(res.status).toBe(200);
  });

  it("returns a generic 400 for malformed JSON, with no parser internals", async () => {
    for (const path of ["/api/trpc/chat.send", "/api/trpc/files.upload", "/api/other"]) {
      const res = await send({ path, headers: authed, body: '{"json": {"message": ' });
      expect(res.status, path).toBe(400);
      expect(JSON.parse(res.body)).toEqual({ error: "Malformed request body" });
      expect(res.body).not.toMatch(/SyntaxError|Unexpected|at \w+|node_modules|\.js:|position/i);
    }
    expect(expensiveCalls).toBe(0);
  });

  it("does not parse or process a body with the wrong content type", async () => {
    const big = "x".repeat(2 * MIB);
    for (const type of ["text/plain", "application/x-www-form-urlencoded", "application/octet-stream", "multipart/form-data; boundary=x"]) {
      const res = await send({ path: "/api/trpc/chat.send", headers: { "content-type": type, cookie: GOOD_COOKIE }, body: big });
      expect(res.status, type).toBeGreaterThanOrEqual(400);
      expect(res.status, type).toBeLessThan(500);
    }
    expect(expensiveCalls).toBe(0);
  });

  it("refuses compressed request bodies instead of inflating them (decompression bomb)", async () => {
    const bomb = gzipSync(Buffer.alloc(40 * MIB, 0x61)); // tiny on the wire, 40 MiB inflated
    expect(bomb.length).toBeLessThan(100 * 1024);
    for (const [path, headers] of [["/api/trpc/chat.send", authed], ["/api/trpc/files.upload", authed], ["/api/other", json]] as const) {
      const res = await send({ path, headers: { ...headers, "content-encoding": "gzip" }, body: bomb });
      expect(res.status, path).toBe(415);
      expect(JSON.parse(res.body)).toEqual({ error: "Unsupported request encoding" });
    }
    expect(expensiveCalls).toBe(0);
  });

  it("applies the small limit to non-tRPC routes too (no alternate large-body path)", async () => {
    expect((await send({ path: "/api/other", headers: authed, body: JSON.stringify({ a: 1 }) })).status).toBe(200);
    expect((await send({ path: "/api/other", headers: authed, body: JSON.stringify({ a: "x".repeat(DEFAULT_BODY_LIMIT_BYTES + 1) }) })).status).toBe(413);
    expect((await send({ path: "/api/storage/anything", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "a=" + "x".repeat(DEFAULT_BODY_LIMIT_BYTES + 1) })).status).toBe(413);
  });

  it("never reveals internals in rejection responses", async () => {
    const res = await send({ path: "/api/trpc/chat.send", headers: authed, body: trpcBody({ message: "x".repeat(DEFAULT_BODY_LIMIT_BYTES + 5) }) });
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).not.toMatch(/stack|express|body-parser|raw-body|limit|expected|length/i);
  });
});
