import type { Express, Request } from "express";
import type { User } from "../../drizzle/schema";
import { findStorageObjectOwners, getWorkspaceForUser } from "../db";
import { storageGetSignedUrl } from "../storage";
import { resolveAuthorizedStorageKey } from "../storageAccess";
import { sdk } from "./sdk";

export type StorageProxyDependencies = {
  /** Canonical SakthiAI authentication (cookie/Bearer, signature, revocation). Throws when unauthenticated. */
  authenticate: (req: Request) => Promise<User>;
  /** Returns the persisted storage key the user may access, or null. */
  authorize: (user: User, rawKey: string) => Promise<string | null>;
  /** Mints a short-lived signed URL. Only ever called after authorization succeeds. */
  sign: (authorizedKey: string) => Promise<string>;
};

const defaultDependencies: StorageProxyDependencies = {
  authenticate: req => sdk.authenticateRequest(req),
  authorize: (user, rawKey) =>
    resolveAuthorizedStorageKey(user, rawKey, {
      findOwners: findStorageObjectOwners,
      getWorkspaceForUser,
    }),
  sign: storageGetSignedUrl,
};

/**
 * GET /api/storage/*
 *
 * 1. Authenticate with the canonical session machinery (401 otherwise).
 * 2. Authorize against persisted ownership + workspace membership. Unknown,
 *    malformed and forbidden objects all return the same 404 so the endpoint is
 *    not a cross-tenant existence oracle.
 * 3. Only then mint a signed URL, for the key as persisted in the database.
 */
export function registerStorageProxy(
  app: Express,
  deps: StorageProxyDependencies = defaultDependencies,
) {
  app.get("/api/storage/*", async (req, res) => {
    res.set("Cache-Control", "no-store");

    let user: User;
    try {
      user = await deps.authenticate(req);
    } catch {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    let authorizedKey: string | null;
    try {
      authorizedKey = await deps.authorize(user, (req.params as Record<string, string>)[0] ?? "");
    } catch (error) {
      console.error("[StorageProxy] authorization lookup failed:", error instanceof Error ? error.message : "unknown");
      res.status(503).json({ error: "Storage temporarily unavailable" });
      return;
    }

    if (!authorizedKey) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    try {
      const url = await deps.sign(authorizedKey);
      res.redirect(307, url);
    } catch (error) {
      console.error("[StorageProxy] signing failed:", error instanceof Error ? error.message : "unknown");
      res.status(502).json({ error: "Storage backend error" });
    }
  });
}
