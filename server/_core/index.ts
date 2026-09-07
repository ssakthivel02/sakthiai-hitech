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

function isPortAvailable(port: number): Promise<boolean> { return new Promise(resolve => { const server = net.createServer(); server.listen(port, () => server.close(() => resolve(true))); server.on("error", () => resolve(false)); }); }
async function findAvailablePort(startPort = 3000): Promise<number> { for (let port = startPort; port < startPort + 20; port++) if (await isPortAvailable(port)) return port; throw new Error(`No available port found starting from ${startPort}`); }

async function startServer() {
  const app = express(); const server = createServer(app);
  app.use((req, res, next) => { const requestId = req.header("x-request-id") || randomUUID(); res.setHeader("x-request-id", requestId); const started = Date.now(); res.on("finish", () => console.log(JSON.stringify({ event: "http_request", requestId, method: req.method, path: req.path, status: res.statusCode, latencyMs: Date.now() - started }))); next(); });
  app.use(express.json({ limit: "50mb" })); app.use(express.urlencoded({ limit: "50mb", extended: true }));
  app.get("/healthz", (_req, res) => res.status(200).json({ status: "alive" }));
  app.get("/readyz", async (_req, res) => { const db = await getDb(); const ready = Boolean(db); res.status(ready ? 200 : 503).json({ status: ready ? "ready" : "not_ready", dependencies: { database: ready ? "usable" : "unavailable", embeddings: embeddingStatus(), scanner: "SCANNER_NOT_CONFIGURED" } }); });
  registerStorageProxy(app); registerOAuthRoutes(app);
  app.use("/api/trpc", createExpressMiddleware({ router: appRouter, createContext }));
  if (process.env.NODE_ENV === "development") await setupVite(app, server); else serveStatic(app);
  const preferredPort = parseInt(process.env.PORT || "3000"); const port = await findAvailablePort(preferredPort); if (port !== preferredPort) console.log(`Port ${preferredPort} is busy, using port ${port} instead`); server.listen(port, () => console.log(`Server running on http://localhost:${port}/`));
}
startServer().catch(console.error);
