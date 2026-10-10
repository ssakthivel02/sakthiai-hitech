import {
  COOKIE_NAME,
  ONE_YEAR_MS,
  OAUTH_PKCE_COOKIE,
  OAUTH_STATE_COOKIE,
  decodeOAuthState,
} from "@shared/const";
import { parse as parseCookieHeader } from "cookie";
import type { Express, Request, Response } from "express";
import * as db from "../db";
import { getSessionCookieOptions } from "./cookies";
import {
  isAcceptableStateLength,
  isValidPkceVerifier,
  pkceS256Challenge,
  resolveCallbackRedirectUri,
  resolvePostLoginPath,
  safeEqual,
} from "./oauthSafety";
import { InMemoryRateLimiter } from "./rateLimit";
import { getLoginTransactionStore, isWellFormedChallenge, newLoginNonce, type LoginTransactionStore } from "./loginTransactions";
import { sdk } from "./sdk";
import { sessionGenerationFromDate } from "./sessionRevocation";

function getQueryParam(req: Request, key: string): string | undefined {
  const value = req.query[key];
  return typeof value === "string" ? value : undefined;
}

const BEGIN_POLICY = { name: "oauth-begin", maxRequests: 600, windowMs: 60_000 } as const; // flood guard for table growth; behind a proxy without trust-proxy req.ip is the proxy, so this is deliberately a high shared ceiling
const beginLimiter = new InMemoryRateLimiter();

export function registerOAuthRoutes(app: Express, injectedStore?: LoginTransactionStore) {
  const store = () => injectedStore ?? getLoginTransactionStore(db.getDb);

  // Server-issued login transaction: the nonce is generated here (never by the browser), bound to the PKCE
  // challenge, stored as digests in the shared database and valid for ten minutes.
  app.post("/api/oauth/begin", async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    const decision = beginLimiter.consume(req.ip || "unknown", BEGIN_POLICY);
    if (!decision.allowed) {
      res.setHeader("Retry-After", String(Math.ceil(decision.retryAfterMs / 1000)));
      res.status(429).json({ error: "too many login attempts" });
      return;
    }
    const challenge = (req.body as { challenge?: unknown } | undefined)?.challenge;
    if (!isWellFormedChallenge(challenge)) {
      res.status(400).json({ error: "valid PKCE challenge required" });
      return;
    }
    try {
      const nonce = newLoginNonce();
      await store().begin(nonce, challenge);
      res.status(201).json({ nonce, expiresInSeconds: 600 });
    } catch {
      res.status(503).json({ error: "login unavailable" });
    }
  });

  app.get("/api/oauth/callback", async (req: Request, res: Response) => {
    const code = getQueryParam(req, "code");
    const state = getQueryParam(req, "state");

    if (!code || !state) {
      res.status(400).json({ error: "code and state are required" });
      return;
    }

    const rejectState = () => res.status(403).json({ error: "invalid oauth state" });
    if (!isAcceptableStateLength(state)) {
      rejectState();
      return;
    }

    const decodedState = decodeOAuthState(state);
    const cookies = parseCookieHeader(req.headers.cookie ?? "");
    const { nonce } = decodedState;
    const expectedNonce = cookies[OAUTH_STATE_COOKIE];
    if (!nonce || nonce !== expectedNonce) {
      rejectState();
      return;
    }

    // The nonce and PKCE cookies are single-use: cleared whatever happens next.
    const clearOptions = { path: "/", secure: true, sameSite: "lax" as const };
    res.clearCookie(OAUTH_STATE_COOKIE, clearOptions);
    res.clearCookie(OAUTH_PKCE_COOKIE, clearOptions);

    // PKCE (S256): the verifier cookie must match the challenge committed to in `state`,
    // tying it to this very authentication transaction.
    const codeVerifier = cookies[OAUTH_PKCE_COOKIE];
    if (
      !isValidPkceVerifier(codeVerifier) ||
      typeof decodedState.challenge !== "string" ||
      !safeEqual(pkceS256Challenge(codeVerifier), decodedState.challenge)
    ) {
      rejectState();
      return;
    }
    let consumed: boolean;
    try {
      consumed = await store().consume(nonce, decodedState.challenge);
    } catch {
      // Cannot prove the transaction is fresh: fail closed without exposing details.
      res.status(503).json({ error: "login transaction store unavailable" });
      return;
    }
    if (!consumed) {
      rejectState();
      return;
    }

    // `state` is client-controlled: only the server's own callback URL may reach the token endpoint.
    const redirectUri = resolveCallbackRedirectUri(decodedState.redirectUri, req);
    if (!redirectUri) {
      rejectState();
      return;
    }

    try {
      const tokenResponse = await sdk.exchangeCodeForToken(code, { redirectUri, codeVerifier });
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
      res.redirect(302, resolvePostLoginPath(decodedState.returnTo, new URL(redirectUri).origin));
    } catch (error) {
      console.error("[OIDC] Callback failed", error);
      res.status(500).json({ error: "Authentication callback failed" });
    }
  });

  app.post("/api/auth/revoke-all", async (req: Request, res: Response) => {
    const cookieOptions = getSessionCookieOptions(req);
    let user;
    try {
      user = await sdk.authenticateRequest(req);
    } catch {
      // An expired/revoked token is already unusable server-side. Clear the
      // stale browser credential as well so logout remains idempotent.
      res.clearCookie(COOKIE_NAME, cookieOptions);
      res.setHeader("Cache-Control", "no-store, max-age=0");
      res.status(401).json({ error: "Valid session required" });
      return;
    }

    try {
      await sdk.revokeAllSessions(user.openId);
      res.clearCookie(COOKIE_NAME, cookieOptions);
      res.setHeader("Cache-Control", "no-store, max-age=0");
      res.status(204).end();
    } catch (error) {
      console.error("[Auth] Session revocation failed", error);
      res.status(503).json({ error: "Session revocation unavailable" });
    }
  });
}
