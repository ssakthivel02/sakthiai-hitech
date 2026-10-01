import { createHash, randomBytes } from "node:crypto";
import { OAUTH_PKCE_COOKIE, OAUTH_STATE_COOKIE, encodeOAuthState } from "@shared/const";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Behavioural tests for GET /api/oauth/callback. The real Express route, the real
 * sdk token exchange and the real validators run against a REAL local fake OIDC
 * provider (token + userinfo endpoints) that enforces redirect_uri equality, code
 * single-use and S256 PKCE exactly like a standards-compliant provider. Only
 * persistence is replaced.
 */

const dbMock = vi.hoisted(() => ({
  upsertUser: vi.fn(async () => undefined),
  advanceUserSessionGeneration: vi.fn(async () => new Date("2026-01-01T00:00:10Z")),
}));
vi.mock("../db", () => dbMock);

import { ENV } from "./env";
import { OAuthTransactionLedger, pkceS256Challenge, resolvePostLoginPath, resolveCallbackRedirectUri } from "./oauthSafety";
import { registerOAuthRoutes } from "./oauth";

// ---- fake OIDC provider ---------------------------------------------------------------
type Grant = { challenge: string; redirectUri: string; used: boolean };
const grants = new Map<string, Grant>();
const tokenRequests: URLSearchParams[] = [];
let provider: http.Server;
let providerPort = 0;

function startProvider() {
  provider = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      const reply = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
      if (req.url === "/token") {
        const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
        tokenRequests.push(form);
        const grant = grants.get(form.get("code") ?? "");
        const verifier = form.get("code_verifier") ?? "";
        if (!grant || grant.used) return reply(400, { error: "invalid_grant" });
        grant.used = true; // authorization codes are single-use
        if (form.get("redirect_uri") !== grant.redirectUri) return reply(400, { error: "invalid_grant", why: "redirect_uri" });
        if (createHash("sha256").update(verifier).digest("base64url") !== grant.challenge) return reply(400, { error: "invalid_grant", why: "pkce" });
        return reply(200, { access_token: "at-" + form.get("code") });
      }
      if (req.url === "/userinfo") return reply(200, { sub: "user-123", name: "Test User", email: "t@example.invalid" });
      reply(404, {});
    });
  });
  return new Promise<void>(resolve => provider.listen(0, "127.0.0.1", () => { providerPort = (provider.address() as AddressInfo).port; resolve(); }));
}

// ---- the app under test ---------------------------------------------------------------
let app: http.Server;
let appPort = 0;
let ledger: OAuthTransactionLedger;
const HOST = () => `127.0.0.1:${appPort}`;
const CALLBACK = () => `http://${HOST()}/api/oauth/callback`;

beforeAll(async () => {
  await startProvider();
  Object.assign(ENV, {
    cookieSecret: "x".repeat(48),
    oidcTokenUrl: `http://127.0.0.1:${providerPort}/token`,
    oidcUserInfoUrl: `http://127.0.0.1:${providerPort}/userinfo`,
    oidcClientId: "sakthiai",
    oidcRedirectUri: "",
    isProduction: false,
  });
  const expressApp = express();
  ledger = new OAuthTransactionLedger();
  registerOAuthRoutes(expressApp, ledger);
  app = http.createServer(expressApp);
  await new Promise<void>(resolve => app.listen(0, "127.0.0.1", resolve));
  appPort = (app.address() as AddressInfo).port;
});
afterAll(async () => {
  app.closeAllConnections(); provider.closeAllConnections();
  await Promise.all([new Promise(r => app.close(r)), new Promise(r => provider.close(r))]);
});
beforeEach(() => { grants.clear(); tokenRequests.length = 0; dbMock.upsertUser.mockClear(); });

// ---- helpers emulating the browser side of startLogin() ---------------------------------
const b64url = (b: Buffer) => b.toString("base64url");
type Login = { state: string; code: string; cookie: string; nonce: string; verifier: string };
function beginLogin(opts: { returnTo?: string; redirectUri?: string; stateOverride?: Record<string, unknown> } = {}): Login {
  const nonce = randomBytes(16).toString("hex");
  const verifier = b64url(randomBytes(32));
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const redirectUri = opts.redirectUri ?? CALLBACK();
  // An attacker is not limited to the browser helper (btoa rejects non-Latin-1): encode with Buffer.
  const state = Buffer.from(JSON.stringify({ redirectUri, nonce, challenge, ...(opts.returnTo !== undefined ? { returnTo: opts.returnTo } : {}), ...(opts.stateOverride ?? {}) })).toString("base64");
  const code = "code-" + randomBytes(6).toString("hex");
  grants.set(code, { challenge, redirectUri: CALLBACK(), used: false });
  return { state, code, nonce, verifier, cookie: `${OAUTH_STATE_COOKIE}=${nonce}; ${OAUTH_PKCE_COOKIE}=${verifier}` };
}

type Reply = { status: number; location?: string; body: string; setCookie: string[] };
function callback(query: { code?: string; state?: string }, cookie?: string, host?: string): Promise<Reply> {
  const params = new URLSearchParams();
  if (query.code !== undefined) params.set("code", query.code);
  if (query.state !== undefined) params.set("state", query.state);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: appPort, path: `/api/oauth/callback?${params}`, method: "GET", headers: { ...(cookie ? { cookie } : {}), ...(host ? { host } : {}) } }, res => {
      const parts: Buffer[] = [];
      res.on("data", c => parts.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, location: res.headers.location, body: Buffer.concat(parts).toString("utf8"), setCookie: (res.headers["set-cookie"] as string[] | undefined) ?? [] }));
    });
    req.on("error", reject);
    req.end();
  });
}
const sessionIssued = (r: Reply) => r.setCookie.some(c => c.startsWith("app_session_id="));
const expectRejected = (r: Reply) => { expect(r.status).toBe(403); expect(JSON.parse(r.body)).toEqual({ error: "invalid oauth state" }); expect(sessionIssued(r)).toBe(false); expect(r.location).toBeUndefined(); expect(tokenRequests).toHaveLength(0); expect(dbMock.upsertUser).not.toHaveBeenCalled(); };

// ---- tests ------------------------------------------------------------------------------
describe("successful login and post-login destination", () => {
  it("completes the flow (nonce + PKCE + redirect_uri verified end to end) and lands on / by default", async () => {
    const login = beginLogin();
    const r = await callback({ code: login.code, state: login.state }, login.cookie);
    expect(r.status).toBe(302);
    expect(r.location).toBe("/");
    expect(sessionIssued(r)).toBe(true);
    expect(tokenRequests).toHaveLength(1);
    expect(tokenRequests[0].get("code_verifier")).toBe(login.verifier);
    expect(tokenRequests[0].get("redirect_uri")).toBe(CALLBACK());
  });

  it("honours a legitimate relative returnTo", async () => {
    for (const [given, expected] of [["/projects/42", "/projects/42"], ["/files?tab=recent#top", "/files?tab=recent#top"], ["/a/../b", "/b"]] as const) {
      const login = beginLogin({ returnTo: given });
      const r = await callback({ code: login.code, state: login.state }, login.cookie);
      expect([r.status, r.location], given).toEqual([302, expected]);
    }
  });

  it("honours a same-origin absolute returnTo, reduced to its path", async () => {
    const login = beginLogin({ returnTo: `http://${HOST()}/projects/7?x=1` });
    const r = await callback({ code: login.code, state: login.state }, login.cookie);
    expect([r.status, r.location]).toEqual([302, "/projects/7?x=1"]);
  });

  it("never redirects to an external origin, whatever the spelling (login still succeeds, destination falls back to /)", async () => {
    const attempts = [
      "https://evil.example/x",
      "http://evil.example",
      `http://${HOST()}.evil.example/x`,
      `http://user@evil.example/`,
      `http://${HOST()}@evil.example/`,
      "//evil.example/x",
      "///evil.example",
      "/\\evil.example",
      "\\\\evil.example",
      "\\/evil.example",
      "/\t/evil.example",
      "/\n/evil.example",
      "https:evil.example",
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:x",
      "evil.example/path",
      "%2F%2Fevil.example",
      "/%2F/evil.example",
      "/%2f%2fevil.example",
      "/%5Cevil.example",
      "/%252F%252Fevil.example", // double encoded
      "/%25252F%25252Fevil.example", // triple encoded
      "https%3A%2F%2Fevil.example",
      "/https://evil.example",
      "/ｅｖｉｌ.example",
      "／／evil.example", // full-width solidus
      "http://evil.example%2f@" + HOST(),
      " https://evil.example",
      "x".repeat(600),
      "/" + "a".repeat(600),
    ];
    for (const raw of attempts) {
      const login = beginLogin({ returnTo: raw });
      const r = await callback({ code: login.code, state: login.state }, login.cookie);
      expect(r.status, raw).toBe(302);
      const location = r.location ?? "";
      expect(location.startsWith("/") && !location.startsWith("//") && !location.includes("\\"), `${JSON.stringify(raw)} -> ${location}`).toBe(true);
      expect(location, raw).not.toMatch(/evil/i);
    }
  });

  it("ignores a non-string returnTo", async () => {
    for (const raw of [{ a: 1 }, ["/x"], 5, null]) {
      const login = beginLogin({ stateOverride: { returnTo: raw } });
      const r = await callback({ code: login.code, state: login.state }, login.cookie);
      expect([r.status, r.location]).toEqual([302, "/"]);
    }
  });
});

describe("resolvePostLoginPath policy", () => {
  it("is an allowlist: only same-site relative paths come out", () => {
    expect(resolvePostLoginPath("/ok")).toBe("/ok");
    expect(resolvePostLoginPath("/ok", "https://app.example")).toBe("/ok");
    expect(resolvePostLoginPath("https://app.example/in?q=1", "https://app.example")).toBe("/in?q=1");
    expect(resolvePostLoginPath("https://app.example.evil/in", "https://app.example")).toBe("/");
    expect(resolvePostLoginPath("https://app.example/in")).toBe("/"); // no allowed origin -> no absolute URLs at all
    expect(resolvePostLoginPath(undefined)).toBe("/");
    expect(resolvePostLoginPath("")).toBe("/");
  });
});

describe("state integrity and CSRF (existing semantics preserved)", () => {
  it("requires code and state", async () => {
    expect((await callback({ state: "x" }, "")).status).toBe(400);
    expect((await callback({ code: "x" }, "")).status).toBe(400);
  });

  it("rejects malformed state of every shape without exchanging a code", async () => {
    const login = beginLogin();
    for (const state of ["%%%", "not base64!!", Buffer.from("not json").toString("base64"), btoa("{}"), btoa('{"redirectUri":5}'), btoa("[]"), "A".repeat(5000), btoa(JSON.stringify({ redirectUri: CALLBACK() }))]) {
      expectRejected(await callback({ code: login.code, state }, login.cookie));
    }
  });

  it("rejects a state whose nonce does not match the browser's cookie (login CSRF)", async () => {
    const attacker = beginLogin();
    const victim = beginLogin();
    expectRejected(await callback({ code: attacker.code, state: attacker.state }, victim.cookie));
  });

  it("rejects a callback with no nonce cookie at all", async () => {
    const login = beginLogin();
    expectRejected(await callback({ code: login.code, state: login.state }));
  });

  it("rejects a legacy nonce-less state", async () => {
    const login = beginLogin();
    expectRejected(await callback({ code: login.code, state: btoa(CALLBACK()) }, login.cookie));
  });

  it("clears both single-use cookies on a rejected nonce-valid attempt too", async () => {
    const login = beginLogin();
    const r = await callback({ code: login.code, state: login.state }, `${OAUTH_STATE_COOKIE}=${login.nonce}`); // PKCE cookie absent
    expect(r.status).toBe(403);
    expect(r.setCookie.join("\n")).toContain(OAUTH_STATE_COOKIE);
    expect(r.setCookie.join("\n")).toContain(OAUTH_PKCE_COOKIE);
  });
});

describe("redirect_uri comes from server policy, not from client state", () => {
  it("never sends an attacker-chosen redirect_uri to the token endpoint", async () => {
    for (const bad of ["https://evil.example/api/oauth/callback", "http://evil.example/api/oauth/callback", `${CALLBACK()}?next=https://evil.example`, `${CALLBACK()}#x`, `${CALLBACK()}/`, `http://${HOST()}/api/oauth/callback/../callback`, `http://${HOST()}/evil`, `http://user@${HOST()}/api/oauth/callback`, "//evil.example/api/oauth/callback", "javascript:alert(1)", `http://${HOST()}.evil.example/api/oauth/callback`, `HTTP://${HOST()}/api/oauth/callback`, `http://${HOST()}/API/OAUTH/CALLBACK`]) {
      const login = beginLogin({ redirectUri: bad });
      expectRejected(await callback({ code: login.code, state: login.state }, login.cookie));
    }
  });

  it("binds to the Host the request was actually made to", async () => {
    const login = beginLogin({ redirectUri: "http://other.example/api/oauth/callback" });
    expectRejected(await callback({ code: login.code, state: login.state }, login.cookie));
  });

  it("uses an explicitly configured OIDC_REDIRECT_URI as the exact (only) value when set", () => {
    const original = ENV.oidcRedirectUri;
    try {
      ENV.oidcRedirectUri = "https://app.example.com/api/oauth/callback";
      expect(resolveCallbackRedirectUri("https://app.example.com/api/oauth/callback", { headers: { host: "anything" } })).toBe("https://app.example.com/api/oauth/callback");
      expect(resolveCallbackRedirectUri("https://app.example.com/api/oauth/callback?x=1", { headers: { host: "app.example.com" } })).toBeNull();
      expect(resolveCallbackRedirectUri("https://evil.example/api/oauth/callback", { headers: { host: "evil.example" } })).toBeNull();
    } finally {
      ENV.oidcRedirectUri = original;
    }
  });

  it("requires https outside loopback development", () => {
    const original = ENV.isProduction;
    try {
      expect(resolveCallbackRedirectUri("http://app.example.com/api/oauth/callback", { headers: { host: "app.example.com" } })).toBeNull();
      expect(resolveCallbackRedirectUri("https://app.example.com/api/oauth/callback", { headers: { host: "app.example.com" } })).toBe("https://app.example.com/api/oauth/callback");
      ENV.isProduction = true;
      expect(resolveCallbackRedirectUri(`http://127.0.0.1:${appPort}/api/oauth/callback`, { headers: { host: HOST() } })).toBeNull();
    } finally {
      ENV.isProduction = original;
    }
  });
});

describe("PKCE (S256)", () => {
  it("sends the cookie verifier to the token endpoint and the provider verifies it against the challenge", async () => {
    const login = beginLogin();
    const r = await callback({ code: login.code, state: login.state }, login.cookie);
    expect(r.status).toBe(302);
    expect(pkceS256Challenge(login.verifier)).toBe(createHash("sha256").update(login.verifier).digest("base64url"));
    expect(tokenRequests[0].get("code_verifier")).toBe(login.verifier);
  });

  it("matches the RFC 7636 appendix B test vector", () => {
    expect(pkceS256Challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("rejects a verifier that does not match the challenge committed in state, before any token request", async () => {
    const login = beginLogin();
    const wrong = b64url(randomBytes(32));
    expectRejected(await callback({ code: login.code, state: login.state }, `${OAUTH_STATE_COOKIE}=${login.nonce}; ${OAUTH_PKCE_COOKIE}=${wrong}`));
  });

  it("rejects a missing PKCE cookie (fail closed) and malformed verifiers", async () => {
    const login = beginLogin();
    expectRejected(await callback({ code: login.code, state: login.state }, `${OAUTH_STATE_COOKIE}=${login.nonce}`));
    for (const bad of ["short", "a".repeat(129), "a".repeat(42) + "!", "a".repeat(43) + " "]) {
      const l = beginLogin();
      expectRejected(await callback({ code: l.code, state: l.state }, `${OAUTH_STATE_COOKIE}=${l.nonce}; ${OAUTH_PKCE_COOKIE}=${bad}`));
    }
  });

  it("rejects a state with no challenge, or a challenge that is not S256 of the verifier (plain downgrade)", async () => {
    const login = beginLogin({ stateOverride: { challenge: undefined } });
    expectRejected(await callback({ code: login.code, state: login.state }, login.cookie));
    const plain = beginLogin();
    const downgraded = encodeOAuthState({ redirectUri: CALLBACK(), nonce: plain.nonce, challenge: plain.verifier });
    expectRejected(await callback({ code: plain.code, state: downgraded }, plain.cookie));
  });

  it("a mixed-up transaction (state/nonce from one login, verifier from another) is refused", async () => {
    const a = beginLogin();
    const b = beginLogin();
    expectRejected(await callback({ code: a.code, state: a.state }, `${OAUTH_STATE_COOKIE}=${a.nonce}; ${OAUTH_PKCE_COOKIE}=${b.verifier}`));
  });

  it("the provider itself refuses a wrong verifier even if the server-side binding were bypassed", async () => {
    const login = beginLogin();
    const response = await fetch(ENV.oidcTokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code: login.code, redirect_uri: CALLBACK(), client_id: "sakthiai", code_verifier: b64url(randomBytes(32)) }) });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { why: string }).why).toBe("pkce");
  });
});

describe("replay", () => {
  it("a callback cannot be completed twice: browser cookies are cleared and the nonce is remembered", async () => {
    const login = beginLogin();
    const first = await callback({ code: login.code, state: login.state }, login.cookie);
    expect(first.status).toBe(302);
    expect(first.setCookie.join("\n")).toContain(OAUTH_STATE_COOKIE);
    expect(first.setCookie.join("\n")).toContain(OAUTH_PKCE_COOKIE);
    const tokenCallsAfterFirst = tokenRequests.length;
    dbMock.upsertUser.mockClear();
    // 1) browser replay: cookies were cleared
    const noCookies = await callback({ code: login.code, state: login.state });
    expect(noCookies.status).toBe(403);
    // 2) attacker who captured the cookies as well: the nonce is single-use server-side
    const withCookies = await callback({ code: login.code, state: login.state }, login.cookie);
    expect(withCookies.status).toBe(403);
    expect(sessionIssued(withCookies)).toBe(false);
    expect(tokenRequests.length).toBe(tokenCallsAfterFirst);
    expect(dbMock.upsertUser).not.toHaveBeenCalled();
  });

  it("the ledger forgets a nonce only after its lifetime", () => {
    let now = 1000;
    const l = new OAuthTransactionLedger(100, () => now);
    expect(l.consume("n")).toBe(true);
    expect(l.consume("n")).toBe(false);
    now += 101;
    expect(l.consume("n")).toBe(true);
  });
});

describe("provider failure", () => {
  it("returns a generic 500 and leaks nothing when the provider rejects the exchange", async () => {
    const login = beginLogin();
    grants.get(login.code)!.used = true; // provider will answer invalid_grant
    const r = await callback({ code: login.code, state: login.state }, login.cookie);
    expect(r.status).toBe(500);
    expect(JSON.parse(r.body)).toEqual({ error: "Authentication callback failed" });
    expect(sessionIssued(r)).toBe(false);
  });
});
