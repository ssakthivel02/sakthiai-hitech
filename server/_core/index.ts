import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { randomUUID } from "node:crypto";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { registerStorageProxy } from "./storageProxy";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import { getDb } from "../db";
import { embeddingStatus } from "../embeddings";
import { ENV } from "./env";

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

async function startServer() {
  const app = express();
  const server = createServer(app);

  app.use((req, res, next) => {
    const requestId = req.header("x-request-id") || randomUUID();
    res.setHeader("x-request-id", requestId);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("Permissions-Policy", "camera=(), geolocation=(), payment=(), usb=()");
    res.setHeader(
      "Content-Security-Policy-Report-Only",
      "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; font-src 'self' data: https:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; connect-src 'self' https:; frame-ancestors 'self'",
    );
    if (req.path.startsWith("/api/") || req.path === "/readyz" || req.path === "/healthz" || req.path === "/releasez") {
      res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
    }

    const started = Date.now();
    res.on("finish", () =>
      console.log(
        JSON.stringify({
          event: "http_request",
          requestId,
          method: req.method,
          path: req.path,
          status: res.statusCode,
          latencyMs: Date.now() - started,
        }),
      ),
    );
    next();
  });

  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));

  app.get("/healthz", (_req, res) =>
    res.status(200).json({
      status: "alive",
      service: "sakthiai",
      environment: process.env.NODE_ENV || "unknown",
    }),
  );

  app.get("/releasez", (_req, res) => res.status(200).json(releaseIdentity()));

  app.get("/readyz", async (_req, res) => {
    const db = await getDb();
    const databaseReady = Boolean(db);
    const authReady = configured(
      ENV.cookieSecret,
      ENV.oidcAuthorizationUrl,
      ENV.oidcTokenUrl,
      ENV.oidcUserInfoUrl,
      ENV.oidcClientId,
    );
    const llmReady = configured(ENV.llmApiUrl, ENV.llmModel);
    const storageReady = configured(
      ENV.storageBucket,
      ENV.storageAccessKeyId,
      ENV.storageSecretAccessKey,
    );
    const ready = databaseReady && authReady && llmReady && storageReady;

    res.status(ready ? 200 : 503).json({
      status: ready ? "ready" : "not_ready",
      service: "sakthiai",
      dependencies: {
        database: databaseReady ? "configured" : "unavailable",
        authentication: authReady ? "configured" : "missing_configuration",
        llm: llmReady ? "configured" : "missing_configuration",
        storage: storageReady ? "configured" : "missing_configuration",
        embeddings: embeddingStatus(),
        scanner: "SCANNER_NOT_CONFIGURED",
      },
    });
  });

  registerStorageProxy(app);
  registerOAuthRoutes(app);
  app.use("/api/trpc", createExpressMiddleware({ router: appRouter, createContext }));

  if (process.env.NODE_ENV === "development") await setupVite(app, server);
  else serveStatic(app);

  const preferredPort = parseInt(process.env.PORT || "3000", 10);
  const port = await findAvailablePort(preferredPort);
  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }
  server.listen(port, "0.0.0.0", () =>
    console.log(`Server running on http://0.0.0.0:${port}/`),
  );
}

startServer().catch(console.error);
