import {
  COOKIE_NAME,
  ONE_YEAR_MS,
  OAUTH_STATE_COOKIE,
  decodeOAuthState,
} from "@shared/const";
import { parse as parseCookieHeader } from "cookie";
import type { Express, Request, Response } from "express";
import * as db from "../db";
import { getSessionCookieOptions } from "./cookies";
import { sdk } from "./sdk";
import { sessionGenerationFromDate } from "./sessionRevocation";

function getQueryParam(req: Request, key: string): string | undefined {
  const value = req.query[key];
  return typeof value === "string" ? value : undefined;
}

export function registerOAuthRoutes(app: Express) {
  app.get("/api/oauth/callback", async (req: Request, res: Response) => {
    const code = getQueryParam(req, "code");
    const state = getQueryParam(req, "state");

    if (!code || !state) {
      res.status(400).json({ error: "code and state are required" });
      return;
    }

    const { nonce } = decodeOAuthState(state);
    const expectedNonce = parseCookieHeader(req.headers.cookie ?? "")[OAUTH_STATE_COOKIE];
    if (!nonce || nonce !== expectedNonce) {
      res.status(403).json({ error: "invalid oauth state" });
      return;
    }
    res.clearCookie(OAUTH_STATE_COOKIE, { path: "/", secure: true, sameSite: "lax" });

    try {
      const tokenResponse = await sdk.exchangeCodeForToken(code, state);
      const userInfo = await sdk.getUserInfo(tokenResponse.accessToken);

      await db.upsertUser({
        openId: userInfo.openId,
        name: userInfo.name,
        email: userInfo.email,
        loginMethod: userInfo.loginMethod,
        lastSignedIn: new Date(),
      });

      // Persist a new generation before issuing the JWT. A subsequent login or
      // explicit revoke-all advances this value, invalidating every older token.
      const generationDate = await db.advanceUserSessionGeneration(userInfo.openId);
      const sessionGeneration = sessionGenerationFromDate(generationDate);
      if (sessionGeneration === null) {
        throw new Error("Unable to establish session generation");
      }

      const sessionToken = await sdk.createSessionToken(userInfo.openId, {
        name: userInfo.name || "User",
        expiresInMs: ONE_YEAR_MS,
        sessionGeneration,
      });

      const cookieOptions = getSessionCookieOptions(req);
      res.cookie(COOKIE_NAME, sessionToken, { ...cookieOptions, maxAge: ONE_YEAR_MS });
      res.redirect(302, "/");
    } catch (error) {
      console.error("[OIDC] Callback failed", error);
      res.status(500).json({ error: "Authentication callback failed" });
    }
  });

  app.post("/api/auth/revoke-all", async (req: Request, res: Response) => {
    let user;
    try {
      user = await sdk.authenticateRequest(req);
    } catch {
      res.status(401).json({ error: "Valid session required" });
      return;
    }

    try {
      await sdk.revokeAllSessions(user.openId);
      res.clearCookie(COOKIE_NAME, getSessionCookieOptions(req));
      res.setHeader("Cache-Control", "no-store, max-age=0");
      res.status(204).end();
    } catch (error) {
      console.error("[Auth] Session revocation failed", error);
      res.status(503).json({ error: "Session revocation unavailable" });
    }
  });
}
