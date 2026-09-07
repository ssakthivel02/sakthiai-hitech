import { COOKIE_NAME, ONE_YEAR_MS, decodeOAuthState } from "@shared/const";
import { ForbiddenError } from "@shared/_core/errors";
import { parse as parseCookieHeader } from "cookie";
import type { Request } from "express";
import { SignJWT, jwtVerify } from "jose";
import type { User } from "../../drizzle/schema";
import * as db from "../db";
import { ENV } from "./env";

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

export type SessionPayload = {
  openId: string;
  appId: string;
  name: string;
};

export type AuthTokenResponse = {
  accessToken: string;
};

export type AuthUserInfo = {
  openId: string;
  name: string | null;
  email: string | null;
  loginMethod: string;
};

class OidcService {
  private assertConfigured() {
    if (!ENV.oidcTokenUrl || !ENV.oidcUserInfoUrl || !ENV.oidcClientId) {
      throw new Error(
        "OIDC is not configured. Set OIDC_TOKEN_URL, OIDC_USERINFO_URL and OIDC_CLIENT_ID."
      );
    }
  }

  async exchangeCodeForToken(code: string, state: string): Promise<AuthTokenResponse> {
    this.assertConfigured();
    const { redirectUri } = decodeOAuthState(state);
    if (!redirectUri) throw new Error("OAuth state is missing redirectUri");

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: ENV.oidcClientId,
    });
    if (ENV.oidcClientSecret) body.set("client_secret", ENV.oidcClientSecret);

    const response = await fetch(ENV.oidcTokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!response.ok) {
      throw new Error(`OIDC token exchange failed with status ${response.status}`);
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const accessToken = payload.access_token;
    if (!isNonEmptyString(accessToken)) {
      throw new Error("OIDC token response did not include access_token");
    }
    return { accessToken };
  }

  async getUserInfo(accessToken: string): Promise<AuthUserInfo> {
    this.assertConfigured();
    const response = await fetch(ENV.oidcUserInfoUrl, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      throw new Error(`OIDC userinfo request failed with status ${response.status}`);
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const subject = payload.sub ?? payload.id ?? payload.user_id;
    if (!isNonEmptyString(subject)) {
      throw new Error("OIDC userinfo response did not include a stable subject identifier");
    }

    return {
      openId: subject,
      name: isNonEmptyString(payload.name)
        ? payload.name
        : isNonEmptyString(payload.preferred_username)
          ? payload.preferred_username
          : null,
      email: isNonEmptyString(payload.email) ? payload.email : null,
      loginMethod: ENV.oidcProviderName,
    };
  }
}

class SDKServer {
  private readonly oidc = new OidcService();

  async exchangeCodeForToken(code: string, state: string): Promise<AuthTokenResponse> {
    return this.oidc.exchangeCodeForToken(code, state);
  }

  async getUserInfo(accessToken: string): Promise<AuthUserInfo> {
    return this.oidc.getUserInfo(accessToken);
  }

  private parseCookies(cookieHeader: string | undefined) {
    if (!cookieHeader) return new Map<string, string>();
    const parsed = parseCookieHeader(cookieHeader);
    return new Map(Object.entries(parsed));
  }

  private getSessionSecret() {
    if (!ENV.cookieSecret) {
      throw new Error("JWT_SECRET is not configured");
    }
    return new TextEncoder().encode(ENV.cookieSecret);
  }

  async createSessionToken(
    openId: string,
    options: { expiresInMs?: number; name?: string } = {}
  ): Promise<string> {
    return this.signSession(
      { openId, appId: ENV.appId, name: options.name || "User" },
      options
    );
  }

  async signSession(
    payload: SessionPayload,
    options: { expiresInMs?: number } = {}
  ): Promise<string> {
    const issuedAt = Date.now();
    const expiresInMs = options.expiresInMs ?? ONE_YEAR_MS;
    const expirationSeconds = Math.floor((issuedAt + expiresInMs) / 1000);

    return new SignJWT({
      openId: payload.openId,
      appId: payload.appId,
      name: payload.name,
    })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuedAt(Math.floor(issuedAt / 1000))
      .setExpirationTime(expirationSeconds)
      .sign(this.getSessionSecret());
  }

  async verifySession(
    cookieValue: string | undefined | null
  ): Promise<SessionPayload | null> {
    if (!cookieValue) return null;

    try {
      const { payload } = await jwtVerify(cookieValue, this.getSessionSecret(), {
        algorithms: ["HS256"],
      });
      const { openId, appId, name } = payload as Record<string, unknown>;
      if (!isNonEmptyString(openId) || !isNonEmptyString(appId) || !isNonEmptyString(name)) {
        return null;
      }
      if (appId !== ENV.appId) return null;
      return { openId, appId, name };
    } catch {
      return null;
    }
  }

  async authenticateRequest(req: Request): Promise<AuthenticatedUser> {
    const cookies = this.parseCookies(req.headers.cookie);
    let sessionToken = cookies.get(COOKIE_NAME);

    // Bearer fallback supports non-browser first-party clients while keeping
    // the token format owned by SakthiAI rather than a preview platform.
    if (!sessionToken) {
      const authHeader = req.headers.authorization;
      if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
        sessionToken = authHeader.slice(7);
      }
    }

    const session = await this.verifySession(sessionToken);
    if (!session) throw ForbiddenError("Invalid session");

    const user = await db.getUserByOpenId(session.openId);
    if (!user) throw ForbiddenError("User not found");

    await db.upsertUser({
      openId: user.openId,
      lastSignedIn: new Date(),
    });

    return user;
  }
}

export type AuthenticatedUser = User;

export const sdk = new SDKServer();
