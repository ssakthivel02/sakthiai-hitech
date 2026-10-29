import express, { type ErrorRequestHandler, type Express, type Request, type RequestHandler, type Response } from "express";
import type { User } from "../../drizzle/schema";

const MIB = 1024 * 1024;

/** Ceiling for every request body unless an authenticated, allow-listed ingestion procedure needs more. */
export const DEFAULT_BODY_LIMIT_BYTES = 256 * 1024;

/**
 * Procedures that legitimately carry file payloads inside the JSON envelope.
 * Only authenticated callers receive these larger limits.
 *
 * - files.upload: 12 MiB file -> 16 MiB base64 + envelope.
 * - creator.submitImage / creator.submitVideo: reference images (<= 12M base64 chars each).
 *   These keep the previous 50 MiB ceiling; no new capacity is granted.
 */
export const INGESTION_BODY_LIMITS: Readonly<Record<string, number>> = Object.freeze({
  "files.upload": 17 * MIB,
  "creator.submitImage": 50 * MIB,
  "creator.submitVideo": 50 * MIB,
});

export type EdgeBodyDependencies = {
  /** Canonical session authentication. Must throw when the request is not authenticated. */
  authenticate: (req: Request) => Promise<User | unknown>;
};

/**
 * Procedure names addressed by a tRPC request path ("/a.b,c.d" for batches), compared EXACTLY as
 * sent. The path is deliberately not percent-decoded: the tRPC client sends plain names, so any "%"
 * (encoded dot, slash, comma or letter) is treated as unknown and gets only the default limit.
 * Null when the path is not a plain "/name[,name...]" list.
 */
export function trpcProcedureNames(path: string): string[] | null {
  if (!/^\/[A-Za-z0-9_.,-]+$/.test(path)) return null;
  const names = path.slice(1).split(",");
  return names.every(name => name.length > 0) ? names : null;
}

/** Largest limit a request could be granted, before authentication. Default unless every procedure is an ingestion one. */
export function requestedIngestionLimit(path: string): number {
  const names = trpcProcedureNames(path);
  if (!names) return DEFAULT_BODY_LIMIT_BYTES;
  let limit = 0;
  for (const name of names) {
    const allowed = Object.prototype.hasOwnProperty.call(INGESTION_BODY_LIMITS, name)
      ? INGESTION_BODY_LIMITS[name]
      : undefined;
    if (allowed === undefined) return DEFAULT_BODY_LIMIT_BYTES;
    limit = Math.max(limit, allowed);
  }
  return Math.max(limit, DEFAULT_BODY_LIMIT_BYTES);
}

// inflate:false -> compressed request bodies are refused (415) so a small wire payload can never expand past the limit.
const parserCache = new Map<number, RequestHandler>();
function jsonParser(limit: number): RequestHandler {
  let parser = parserCache.get(limit);
  if (!parser) {
    parser = express.json({ limit, inflate: false, type: "application/json" });
    parserCache.set(limit, parser);
  }
  return parser;
}

function refuse(req: Request, res: Response, status: 400 | 413, error: string) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Connection", "close");
  res.once("finish", () => req.destroy());
  res.status(status).json({ error });
}

/**
 * body-parser only reports an oversize body after it has drained the whole request,
 * so on its own a declared 4 GB upload is read and discarded before the 413. This
 * guard answers immediately and drops the connection: it rejects an over-limit
 * Content-Length up front and counts bytes of chunked bodies as they arrive.
 * Returns true when the request was refused.
 */
function guardBodySize(req: Request, res: Response, limit: number): boolean {
  const declared = req.headers["content-length"];
  if (declared !== undefined) {
    const length = Number(declared);
    if (!/^\d+$/.test(declared) || !Number.isSafeInteger(length)) {
      refuse(req, res, 400, "Malformed request body");
      return true;
    }
    if (length > limit) {
      refuse(req, res, 413, "Request body too large");
      return true;
    }
    return false;
  }
  if (req.headers["transfer-encoding"]) {
    let received = 0;
    const onData = (chunk: Buffer) => {
      received += chunk.length;
      if (received > limit && !res.headersSent) {
        req.off("data", onData);
        refuse(req, res, 413, "Request body too large");
      }
    };
    req.on("data", onData);
  }
  return false;
}

const smallUrlencoded = express.urlencoded({ limit: DEFAULT_BODY_LIMIT_BYTES, extended: false, inflate: false });

/**
 * Chooses the body limit for a tRPC request. Authentication runs first (cheap JWT
 * check) and only for allow-listed ingestion procedures, so an unauthenticated
 * client is limited to the small default and never makes the server buffer more.
 */
export function trpcBodyParser(deps: EdgeBodyDependencies): RequestHandler {
  return async (req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
      next();
      return;
    }
    let limit = DEFAULT_BODY_LIMIT_BYTES;
    const requested = requestedIngestionLimit(req.path);
    if (requested > DEFAULT_BODY_LIMIT_BYTES) {
      try {
        await deps.authenticate(req);
        limit = requested;
      } catch {
        limit = DEFAULT_BODY_LIMIT_BYTES;
      }
    }
    if (guardBodySize(req, res, limit)) return;
    jsonParser(limit)(req, res, next);
  };
}

/** Maps body-parser failures to fixed, non-revealing responses. */
export const bodyParserErrorHandler: ErrorRequestHandler = (error, _req, res, next) => {
  if (!error || typeof error !== "object") {
    next(error);
    return;
  }
  const type = (error as { type?: string }).type;
  if (typeof type !== "string") {
    next(error);
    return;
  }
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.setHeader("Cache-Control", "no-store");
  switch (type) {
    case "entity.too.large":
      res.status(413).json({ error: "Request body too large" });
      return;
    case "entity.parse.failed":
    case "request.size.invalid":
    case "request.aborted":
    case "stream.encoding.set":
    case "charset.unsupported":
      res.status(400).json({ error: "Malformed request body" });
      return;
    case "encoding.unsupported":
      res.status(415).json({ error: "Unsupported request encoding" });
      return;
    default:
      next(error);
  }
};

/**
 * Registers request-body parsing for the whole app. Replaces the former global 50 MB
 * parsers: tRPC gets per-procedure limits, everything else the small default.
 */
export function registerEdgeBodyParsers(app: Express, deps: EdgeBodyDependencies) {
  const trpcParser = trpcBodyParser(deps);
  const smallJson = jsonParser(DEFAULT_BODY_LIMIT_BYTES);
  app.use("/api/trpc", trpcParser);
  app.use((req, res, next) => {
    if (req.path.startsWith("/api/trpc")) {
      next();
      return;
    }
    if (guardBodySize(req, res, DEFAULT_BODY_LIMIT_BYTES)) return;
    smallJson(req, res, err => (err ? next(err) : smallUrlencoded(req, res, next)));
  });
  app.use(bodyParserErrorHandler);
}
