import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT, decodeJwt } from "jose";

vi.mock("../db", () => ({ getUserByOpenId: vi.fn(), advanceUserSessionGeneration: vi.fn(), upsertUser: vi.fn() }));

import { ENV } from "./env";
import { sdk } from "./sdk";
import { sessionMaxAgeMs } from "./sessionPolicy";

const SECRET = "s".repeat(48);
const DAY = 86_400;
const now = () => Math.floor(Date.now() / 1000);

async function forge(claims: { iat?: number | null; exp?: number }) {
  let jwt = new SignJWT({ openId: "sub-1", appId: ENV.appId, name: "U", sessionGeneration: 1 }).setProtectedHeader({ alg: "HS256", typ: "JWT" }).setJti("j-1");
  if (claims.iat !== null) jwt = jwt.setIssuedAt(claims.iat ?? now());
  return jwt.setExpirationTime(claims.exp ?? now() + 365 * DAY).sign(new TextEncoder().encode(SECRET));
}

beforeEach(() => { ENV.cookieSecret = SECRET; vi.stubEnv("SESSION_MAX_AGE_DAYS", ""); vi.stubEnv("NODE_ENV", "test"); });
afterEach(() => vi.unstubAllEnvs());

describe("session lifetime policy", () => {
  it("defaults to 30 days, honours 1..90, clamps above 90 and ignores invalid values", () => {
    expect(sessionMaxAgeMs()).toBe(30 * DAY * 1000);
    vi.stubEnv("SESSION_MAX_AGE_DAYS", "7"); expect(sessionMaxAgeMs()).toBe(7 * DAY * 1000);
    vi.stubEnv("SESSION_MAX_AGE_DAYS", "365"); expect(sessionMaxAgeMs()).toBe(90 * DAY * 1000);
    for (const bad of ["0", "-3", "abc", "1.5", " "]) { vi.stubEnv("SESSION_MAX_AGE_DAYS", bad); expect(sessionMaxAgeMs()).toBe(30 * DAY * 1000); }
  });

  it("new tokens expire at the configured lifetime, not one year", async () => {
    vi.stubEnv("SESSION_MAX_AGE_DAYS", "14");
    const token = await sdk.createSessionToken("sub-1", { sessionGeneration: 1 });
    const { exp, iat } = decodeJwt(token);
    expect(exp! - iat!).toBe(14 * DAY);
  });
});

describe("verifySession enforces token age server-side", () => {
  it("accepts a fresh token", async () => {
    expect(await sdk.verifySession(await forge({}))).toMatchObject({ openId: "sub-1" });
  });

  it("rejects an already-issued 1-year token once it is older than the max age, even though exp is in the future", async () => {
    expect(await sdk.verifySession(await forge({ iat: now() - 31 * DAY }))).toBeNull();
    vi.stubEnv("SESSION_MAX_AGE_DAYS", "60");
    expect(await sdk.verifySession(await forge({ iat: now() - 31 * DAY }))).not.toBeNull();
  });

  it("rejects a token without iat, or issued in the future (beyond 60 s clock skew)", async () => {
    expect(await sdk.verifySession(await forge({ iat: null }))).toBeNull();
    expect(await sdk.verifySession(await forge({ iat: now() + 3600 }))).toBeNull();
    expect(await sdk.verifySession(await forge({ iat: now() + 30 }))).not.toBeNull();
  });
});

describe("JWT secret strength", () => {
  it("production runtime refuses to sign or verify with a secret shorter than 32 characters (fail closed)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    ENV.cookieSecret = "short-secret";
    await expect(sdk.createSessionToken("sub-1", { sessionGeneration: 1 })).rejects.toThrow(/JWT_SECRET/);
    expect(await sdk.verifySession(await forge({}))).toBeNull();
  });

  it("non-production keeps working with short local secrets", async () => {
    ENV.cookieSecret = "dev";
    await expect(sdk.createSessionToken("sub-1", { sessionGeneration: 1 })).resolves.toBeTypeOf("string");
  });
});

describe("/readyz authentication readiness agrees with what auth will actually do", () => {
  const oidc = ["https://idp/authorize", "https://idp/token", "https://idp/userinfo", "client"];
  it("production + short secret is NOT ready (weak_secret), because every sign-in would fail closed", async () => {
    const { authenticationReadiness } = await import("./sessionPolicy");
    expect(authenticationReadiness({ secret: "short-secret", oidc }, { NODE_ENV: "production" })).toBe("weak_secret");
    expect(authenticationReadiness({ secret: "x".repeat(31), oidc }, { NODE_ENV: "production" })).toBe("weak_secret");
  });
  it("production + 32+ char secret + full OIDC config is configured; anything missing is missing_configuration", async () => {
    const { authenticationReadiness } = await import("./sessionPolicy");
    expect(authenticationReadiness({ secret: "x".repeat(32), oidc }, { NODE_ENV: "production", OWNER_OPEN_ID: "owner-sub" })).toBe("configured");
    expect(authenticationReadiness({ secret: "", oidc }, { NODE_ENV: "production" })).toBe("missing_configuration");
    expect(authenticationReadiness({ secret: "x".repeat(40), oidc: [...oidc.slice(0, 3), ""] }, { NODE_ENV: "production" })).toBe("missing_configuration");
  });
  it("non-production keeps short local secrets usable", async () => {
    const { authenticationReadiness } = await import("./sessionPolicy");
    expect(authenticationReadiness({ secret: "dev", oidc }, { NODE_ENV: "test" })).toBe("configured");
  });
});

describe("/readyz reports a production deployment where nobody may sign in", () => {
  const oidc = ["https://idp/authorize", "https://idp/token", "https://idp/userinfo", "client"];
  const secret = "x".repeat(40);
  it("production with no OWNER_OPEN_ID / AUTH_ALLOWED_* and no AUTH_OPEN_SIGNUP is NOT ready (no_authorized_identities)", async () => {
    const { authenticationReadiness } = await import("./sessionPolicy");
    expect(authenticationReadiness({ secret, oidc }, { NODE_ENV: "production" })).toBe("no_authorized_identities");
  });
  it("any admitted identity source makes it configured", async () => {
    const { authenticationReadiness } = await import("./sessionPolicy");
    for (const extra of [{ OWNER_OPEN_ID: "o" }, { AUTH_ALLOWED_SUBJECTS: "s" }, { AUTH_ALLOWED_EMAILS: "a@b.c" }, { AUTH_OPEN_SIGNUP: "true" }]) {
      expect(authenticationReadiness({ secret, oidc }, { NODE_ENV: "production", ...extra })).toBe("configured");
    }
  });
  it("weak secret and missing configuration still take precedence; non-production unaffected", async () => {
    const { authenticationReadiness } = await import("./sessionPolicy");
    expect(authenticationReadiness({ secret: "short", oidc }, { NODE_ENV: "production" })).toBe("weak_secret");
    expect(authenticationReadiness({ secret: "", oidc }, { NODE_ENV: "production" })).toBe("missing_configuration");
    expect(authenticationReadiness({ secret: "dev", oidc }, { NODE_ENV: "test" })).toBe("configured");
  });
});
