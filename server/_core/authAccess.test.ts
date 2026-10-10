import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Login/session access policy (preview-user restriction). Fail closed in a production runtime. */
const dbMock = vi.hoisted(() => ({ getUserByOpenId: vi.fn(), advanceUserSessionGeneration: vi.fn(), upsertUser: vi.fn() }));
vi.mock("../db", () => dbMock);

import { ENV } from "./env";
import { isIdentityAllowed, loginAccessPolicy } from "./authAccess";
import { sdk } from "./sdk";

const id = (openId: string, email: string | null = null, emailVerified = false) => ({ openId, email, emailVerified });

beforeEach(() => {
  for (const k of ["AUTH_OPEN_SIGNUP", "AUTH_ALLOWED_SUBJECTS", "AUTH_ALLOWED_EMAILS", "OWNER_OPEN_ID"]) vi.stubEnv(k, "");
});
afterEach(() => vi.unstubAllEnvs());

describe("loginAccessPolicy", () => {
  it("production runtime with nothing configured → closed (nobody can sign in)", () => {
    const policy = loginAccessPolicy(process.env, true);
    expect(policy.mode).toBe("closed");
    expect(isIdentityAllowed(policy, id("anyone", "a@b.c", true))).toBe(false);
  });

  it("non-production runtime with nothing configured → open (local development and E2E keep working)", () => {
    expect(loginAccessPolicy(process.env, false).mode).toBe("open");
  });

  it("AUTH_OPEN_SIGNUP must be exactly \"true\" to open a production runtime", () => {
    for (const value of ["1", "yes", "TRUE", " true"]) {
      vi.stubEnv("AUTH_OPEN_SIGNUP", value);
      expect(loginAccessPolicy(process.env, true).mode).toBe("closed");
    }
    vi.stubEnv("AUTH_OPEN_SIGNUP", "true");
    expect(loginAccessPolicy(process.env, true).mode).toBe("open");
  });

  it("owner subject is always admitted and turns the policy into an allowlist", () => {
    vi.stubEnv("OWNER_OPEN_ID", "owner-sub");
    const policy = loginAccessPolicy(process.env, false);
    expect(policy.mode).toBe("allowlist");
    expect(isIdentityAllowed(policy, id("owner-sub"))).toBe(true);
    expect(isIdentityAllowed(policy, id("someone-else"))).toBe(false);
  });

  it("subjects match exactly", () => {
    vi.stubEnv("AUTH_ALLOWED_SUBJECTS", " sub-1 ,sub-2,, ");
    const policy = loginAccessPolicy(process.env, true);
    expect(isIdentityAllowed(policy, id("sub-1"))).toBe(true);
    expect(isIdentityAllowed(policy, id("sub-2"))).toBe(true);
    for (const s of ["sub-", "sub-12", "SUB-1", " sub-1"]) expect(isIdentityAllowed(policy, id(s))).toBe(false);
  });

  it("emails match case-insensitively and ONLY when the provider asserts email_verified", () => {
    vi.stubEnv("AUTH_ALLOWED_EMAILS", "Tester@Example.com");
    const policy = loginAccessPolicy(process.env, true);
    expect(isIdentityAllowed(policy, id("x", "tester@example.com", true))).toBe(true);
    expect(isIdentityAllowed(policy, id("x", "TESTER@example.COM", true))).toBe(true);
    expect(isIdentityAllowed(policy, id("x", "tester@example.com", false))).toBe(false);
    expect(isIdentityAllowed(policy, id("x", "tester@example.com.evil", true))).toBe(false);
    expect(isIdentityAllowed(policy, id("x", null, true))).toBe(false);
  });
});

describe("authenticateRequest re-checks access on every request", () => {
  const user = { id: 1, openId: "sub-1", email: null, name: "U", loginMethod: "oidc", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date("2026-01-01T00:00:10Z") };
  async function request() {
    ENV.cookieSecret = "y".repeat(48);
    const token = await sdk.createSessionToken("sub-1", { sessionGeneration: Math.floor(user.lastSignedIn.getTime() / 1000) });
    return { headers: { authorization: `Bearer ${token}` } } as never;
  }

  it("a valid token for a subject still on the allowlist authenticates", async () => {
    vi.stubEnv("AUTH_ALLOWED_SUBJECTS", "sub-1");
    dbMock.getUserByOpenId.mockResolvedValue(user);
    await expect(sdk.authenticateRequest(await request())).resolves.toMatchObject({ openId: "sub-1" });
  });

  it("a valid token for a subject REMOVED from the allowlist is refused (no 1-year grace)", async () => {
    vi.stubEnv("AUTH_ALLOWED_SUBJECTS", "someone-else");
    dbMock.getUserByOpenId.mockResolvedValue(user);
    await expect(sdk.authenticateRequest(await request())).rejects.toThrow(/not authorized/i);
  });
});
