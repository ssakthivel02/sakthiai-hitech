import "dotenv/config";
import { getTaskRuntime } from "../tasks/shared";
import { runtimeConfigFromEnv } from "../tasks/runtime";
import { getUploadCleanupRunner } from "../ingestion/shared";
import express from "express";
import { createServer } from "http";
import net from "net";
import { randomUUID } from "node:crypto";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerEdgeBodyParsers } from "./bodyLimits";
import { registerOAuthRoutes } from "./oauth";
import { sdk } from "./sdk";
import { registerStorageProxy } from "./storageProxy";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import { embeddingStatus } from "../embeddings";
import { malwareScannerConfigurationStatus } from "../security/malwareScanner";
import { ENV } from "./env";
import { buildHttpRequestLog, sanitizeRequestId } from "./httpTelemetry";
import { probeDatabaseReadiness, probeSchemaReadiness } from "./readiness";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, "0.0.0.0", () => server.close(() => resolve(true)));
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) return port;
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

function parsePort(value: string | undefined, fallback: number): number {
  const port = Number.parseInt(value || String(fallback), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT value: ${value ?? "<unset>"}`);
  }
  return port;
}

function configured(...values: Array<string | undefined>) {
  return values.every(value => typeof value === "string" && value.trim().length > 0);
}

function releaseIdentity() {
  const commit = process.env.RENDER_GIT_COMMIT?.trim() || process.env.GIT_COMMIT?.trim() || "unknown";
  return {
    service: "sakthiai",
    environment: process.env.NODE_ENV || "unknown",
    repository: process.env.RENDER_GIT_REPO_SLUG?.trim() || "ssakthivel02/sakthiai-hitech",
    commit,
    exactCommitKnown: commit !== "unknown",
  };
}

function isOperationalPath(path: string) {
  return path === "/healthz" || path === "/readyz" || path === "/releasez";
}

async function startServer() {
  const app = express();
  app.disable("x-powered-by");
  const server = createServer(app);

  app.use((req, res, next) => {
    const requestId = sanitizeRequestId(req.header("x-request-id"), randomUUID());
    res.setHeader("x-request-id", requestId);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("Permissions-Policy", "camera=(), geolocation=(), payment=(), usb=()");
    if (process.env.NODE_ENV === "production") {
      res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    res.setHeader(
      "Content-Security-Policy-Report-Only",
      "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; font-src 'self' data: https:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; connect-src 'self' https:; frame-ancestors 'self'",
    );
    if (req.path.startsWith("/api/") || isOperationalPath(req.path)) {
      res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
    }
    if (isOperationalPath(req.path)) {
      res.setHeader("Cache-Control", "no-store, max-age=0");
      res.setHeader("Pragma", "no-cache");
    }

    const started = Date.now();
    res.on("finish", () =>
      console.log(
        JSON.stringify(
          buildHttpRequestLog({
            requestId,
            method: req.method,
            path: req.path,
            status: res.statusCode,
            latencyMs: Date.now() - started,
          }),
        ),
      ),
    );
    next();
  });

  registerEdgeBodyParsers(app, { authenticate: req => sdk.authenticateRequest(req) });

  app.get("/healthz", (_req, res) =>
    res.status(200).json({
      status: "alive",
      service: "sakthiai",
      environment: process.env.NODE_ENV || "unknown",
    }),
  );

  app.get("/releasez", (_req, res) => res.status(200).json(releaseIdentity()));

  app.get("/readyz", async (_req, res) => {
    const databaseReady = await probeDatabaseReadiness();
    // Reachable is not enough: the schema must match this build, or every procedure touching a newer table fails.
    const databaseSchema = databaseReady ? await probeSchemaReadiness() : null;
    const schemaCurrent = databaseSchema?.status === "current";
    // /readyz is unauthenticated: publish counts only; operators get the missing table names from the server log.
    if (databaseSchema?.status === "behind") console.warn("readiness: database schema behind this build; missing tables:", databaseSchema.missingTables.join(","), "missing columns:", databaseSchema.missingColumns);
    const authReady = configured(
      ENV.cookieSecret,
      ENV.oidcAuthorizationUrl,
      ENV.oidcTokenUrl,
      ENV.oidcUserInfoUrl,
      ENV.oidcClientId,
    );
    // "configured" only: a local/self-hosted endpoint counts, but reachability is never claimed here (see gateway runtime states).
    const llmReady = configured(ENV.llmApiUrl, ENV.llmModel) || configured(process.env.LOCAL_LLM_API_URL, process.env.LOCAL_LLM_MODEL);
    const storageReady = configured(
      ENV.storageBucket,
      ENV.storageAccessKeyId,
      ENV.storageSecretAccessKey,
    );
    const ready = databaseReady && schemaCurrent && authReady && llmReady && storageReady;

    res.status(ready ? 200 : 503).json({
      status: ready ? "ready" : "not_ready",
      service: "sakthiai",
      dependencies: {
        database: !databaseReady ? "unavailable" : schemaCurrent ? "configured" : "schema_mismatch",
        databaseSchema: databaseSchema
          ? { status: databaseSchema.status, expectedTables: databaseSchema.expectedTables, missingTables: databaseSchema.missingTables.length, missingColumns: databaseSchema.missingColumns }
          : { status: "not_checked" },
        authentication: authReady ? "configured" : "missing_configuration",
        llm: llmReady ? "configured" : "missing_configuration",
        storage: storageReady ? "configured" : "missing_configuration",
        embeddings: embeddingStatus(),
        taskWorker: getTaskRuntime().status(),
        uploadCleanup: getUploadCleanupRunner().status(),
        scanner: {
          configuration: malwareScannerConfigurationStatus(),
          liveProbe: "not_checked",
          requiredForCurrentReadiness: false,
          fileIngestion: "coming_soon",
        },
      },
    });
  });

  registerStorageProxy(app);
  registerOAuthRoutes(app);
  app.use("/api/trpc", createExpressMiddleware({ router: appRouter, createContext, maxBodySize: 50 * 1024 * 1024 }));

  if (process.env.NODE_ENV === "development") await setupVite(app, server);
  else serveStatic(app);

  const preferredPort = parsePort(process.env.PORT, 3000);
  const port = process.env.NODE_ENV === "production" ? preferredPort : await findAvailablePort(preferredPort);
  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }
  server.listen(port, "0.0.0.0", () => {
    console.log(`Server running on http://0.0.0.0:${port}/`);
    // Default OFF (TASK_WORKER_ENABLED). A worker failure is contained inside the runtime and never crashes the HTTP app.
    try { getUploadCleanupRunner().start(); } catch (error) { console.error("upload cleanup failed to start", error instanceof Error ? error.message : error); }
    try { getTaskRuntime().start(); } catch (error) { console.error("task runtime failed to start", error instanceof Error ? error.message : error); }
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received: stopping task runtime, then HTTP server`);
    const force = setTimeout(() => process.exit(1), runtimeConfigFromEnv().shutdownGraceMs + 10_000);
    force.unref?.();
    Promise.all([getUploadCleanupRunner().stop(5_000).catch(() => undefined), getTaskRuntime().stop().catch(() => undefined)])
      .then(() => new Promise<void>(resolve => server.close(() => resolve())))
      .then(() => process.exit(0));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

startServer().catch(console.error);
