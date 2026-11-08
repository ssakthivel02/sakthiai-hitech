import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { OAUTH_PKCE_COOKIE, OAUTH_STATE_COOKIE } from "@shared/const";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  upsertUser: vi.fn(async () => undefined),
  advanceUserSessionGeneration: vi.fn(async () => new Date()),
  getDb: vi.fn(async () => null),
}));
vi.mock("../db", () => dbMock);

import { ENV } from "./env";
import { MemoryLoginTransactionStore, isWellFormedChallenge, isWellFormedNonce, newLoginNonce, type LoginTransactionStore } from "./loginTransactions";
import { registerOAuthRoutes } from "./oauth";

const challengeOf = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");
const newVerifier = () => randomBytes(32).toString("base64url");

describe("MemoryLoginTransactionStore (strict, server-issued)", () => {
  it("consumes a begun transaction exactly once", async () => {
    const store = new MemoryLoginTransactionStore();
    const nonce = newLoginNonce(); const challenge = challengeOf(newVerifier());
    await store.begin(nonce, challenge);
    expect(await store.consume(nonce, challenge)).toBe(true);
    expect(await store.consume(nonce, challenge)).toBe(false);
  });
  it("refuses unknown nonce, wrong challenge, malformed input and expired transactions", async () => {
    let now = 1_000_000;
    const store = new MemoryLoginTransactionStore(1000, () => now);
    const nonce = newLoginNonce(); const challenge = challengeOf(newVerifier());
    await store.begin(nonce, challenge);
    expect(await store.consume(newLoginNonce(), challenge)).toBe(false);
    expect(await store.consume(nonce, challengeOf(newVerifier()))).toBe(false);
    expect(await store.consume("short", challenge)).toBe(false);
    expect(await store.consume(nonce, "not-a-challenge")).toBe(false);
    now += 1001;
    expect(await store.consume(nonce, challenge)).toBe(false);
    await expect(store.begin("bad", challenge)).rejects.toThrow(/malformed/);
  });
  it("validators are strict", () => {
    expect(isWellFormedNonce(newLoginNonce())).toBe(true);
    expect(isWellFormedNonce("a b".padEnd(40, "x"))).toBe(false);
    expect(isWellFormedNonce(undefined)).toBe(false);
    expect(isWellFormedChallenge(challengeOf("x"))).toBe(true);
    expect(isWellFormedChallenge("x".repeat(44))).toBe(false);
  });
});

describe("login transaction routes", () => {
  let server: http.Server; let port = 0;
  let store: LoginTransactionStore & { fail?: "begin" | "consume" };
  const calls = { begin: 0, consume: 0 };

  beforeAll(async () => {
    Object.assign(ENV, { cookieSecret: "x".repeat(48), oidcTokenUrl: "http://127.0.0.1:9/token", oidcUserInfoUrl: "http://127.0.0.1:9/u", oidcClientId: "c", oidcRedirectUri: "", isProduction: false });
    const inner = new MemoryLoginTransactionStore();
    store = {
      fail: undefined,
      async begin(n, c) { calls.begin += 1; if (store.fail === "begin") throw new Error("db down"); return inner.begin(n, c); },
      async consume(n, c) { calls.consume += 1; if (store.fail === "consume") throw new Error("db down"); return inner.consume(n, c); },
    };
    const app = express(); app.use(express.json());
    registerOAuthRoutes(app, store);
    server = http.createServer(app);
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r)); port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); });

  const request = (method: string, path: string, body?: unknown, cookie?: string) => new Promise<{ status: number; json: any }>((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ host: "127.0.0.1", port, path, method, headers: { ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}), ...(cookie ? { cookie } : {}) } }, res => {
      const parts: Buffer[] = []; res.on("data", c => parts.push(c));
      res.on("end", () => { const text = Buffer.concat(parts).toString("utf8"); resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : null }); });
    });
    req.on("error", reject); if (payload) req.write(payload); req.end();
  });

  it("POST /api/oauth/begin issues a high-entropy server nonce for a valid challenge", async () => {
    const challenge = challengeOf(newVerifier());
    const a = await request("POST", "/api/oauth/begin", { challenge });
    const b = await request("POST", "/api/oauth/begin", { challenge });
    expect(a.status).toBe(201); expect(isWellFormedNonce(a.json.nonce)).toBe(true);
    expect(a.json.nonce).not.toBe(b.json.nonce);
  });

  it("rejects missing/malformed challenges without touching the store", async () => {
    const before = calls.begin;
    for (const body of [undefined, {}, { challenge: 5 }, { challenge: "short" }, { challenge: "!".repeat(43) }]) expect((await request("POST", "/api/oauth/begin", body)).status).toBe(400);
    expect(calls.begin).toBe(before);
  });

  it("callback fails closed with 503 (no session, no details) when the store cannot be read", async () => {
    const verifier = newVerifier(); const challenge = challengeOf(verifier); const nonce = newLoginNonce();
    store.fail = "consume";
    const state = Buffer.from(JSON.stringify({ redirectUri: `http://127.0.0.1:${port}/api/oauth/callback`, nonce, challenge })).toString("base64");
    const r = await request("GET", `/api/oauth/callback?code=c&state=${encodeURIComponent(state)}`, undefined, `${OAUTH_STATE_COOKIE}=${nonce}; ${OAUTH_PKCE_COOKIE}=${verifier}`);
    store.fail = undefined;
    expect(r.status).toBe(503);
    expect(JSON.stringify(r.json)).not.toMatch(/db down|nonce|verifier/);
    expect(dbMock.upsertUser).not.toHaveBeenCalled();
  });

  it("begin answers 503 when the store is down, and is rate limited per client (429 with Retry-After semantics)", async () => {
    store.fail = "begin";
    const challenge = challengeOf(newVerifier());
    expect((await request("POST", "/api/oauth/begin", { challenge })).status).toBe(503);
    store.fail = undefined;
    let limited = 0;
    for (let i = 0; i < 620; i += 1) if ((await request("POST", "/api/oauth/begin", { challenge })).status === 429) limited += 1;
    expect(limited).toBeGreaterThan(0);
  });
});
