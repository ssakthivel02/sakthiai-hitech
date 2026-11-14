import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prefersHtml, renderSignInFailurePage, type SignInFailure } from "./signinPages";

vi.mock("../db", () => ({ upsertUser: vi.fn(), advanceUserSessionGeneration: vi.fn() }));
import { registerOAuthRoutes } from "./oauth";
import { MemoryLoginTransactionStore } from "./loginTransactions";

/** Defect D4 (reproduced on 42682d1): a denied sign-in left the browser on a raw JSON body with no way forward. */
const KINDS: SignInFailure[] = ["not_authorized", "link_invalid", "unavailable", "failed"];

describe("prefersHtml", () => {
  const accept = (value?: string) => prefersHtml({ headers: value === undefined ? {} : { accept: value } } as never);
  it("is true for a browser navigation", () => {
    expect(accept("text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")).toBe(true);
    expect(accept("text/html")).toBe(true);
  });
  it("is false for API consumers, fetch defaults and a missing header", () => {
    expect(accept(undefined)).toBe(false);
    expect(accept("*/*")).toBe(false);
    expect(accept("application/json")).toBe(false);
    expect(accept("application/json, text/html")).toBe(false);
  });
});

describe("renderSignInFailurePage", () => {
  it.each(KINDS)("%s: bilingual, accessible, with a recovery route and no script", kind => {
    const html = renderSignInFailurePage(kind, "req-123");
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('lang="ta"');
    expect(html).toContain('role="alert"');
    expect(html).toContain('href="/"');
    expect(html).toContain("viewport");
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/\{"error"/);
  });
  it("the denied page says no account or session was created", () => {
    const html = renderSignInFailurePage("not_authorized");
    expect(html).toMatch(/not on the beta access list/);
    expect(html).toMatch(/No SakthiAI account or session was created/);
  });
  it("shows only a well-formed reference id, escaped, and drops anything else", () => {
    expect(renderSignInFailurePage("failed", "abc-123.DEF_9")).toContain("abc-123.DEF_9");
    for (const hostile of ['"><script>alert(1)</script>', "a b", "x".repeat(200), "<img src=x onerror=1>"]) {
      const html = renderSignInFailurePage("failed", hostile);
      expect(html).not.toContain(hostile);
      expect(html).not.toMatch(/<script|onerror/i);
      expect(html).not.toContain("<code>");
    }
  });
});

describe("GET /api/oauth/callback failure responses", () => {
  let server: http.Server; let base = "";
  beforeAll(async () => {
    const app = express(); app.disable("x-powered-by");
    registerOAuthRoutes(app, new MemoryLoginTransactionStore());
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
  const get = (path: string, accept?: string) => fetch(`${base}${path}`, { headers: accept ? { accept } : {}, redirect: "manual" });

  it("a browser gets a recoverable HTML page and the SAME status code", async () => {
    const res = await get("/api/oauth/callback", "text/html,application/xhtml+xml");
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(res.headers.get("cache-control")).toMatch(/no-store/);
    const body = await res.text();
    expect(body).toContain('href="/"');
    expect(body).not.toContain("code and state are required");
  });
  it("an invalid state is a 403 HTML page for a browser", async () => {
    const res = await get("/api/oauth/callback?code=abc&state=not-valid", "text/html");
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(await res.text()).toMatch(/no longer valid/);
  });
  it("API clients keep the exact JSON bodies and statuses", async () => {
    const missing = await get("/api/oauth/callback");
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: "code and state are required" });
    const bad = await get("/api/oauth/callback?code=abc&state=not-valid", "application/json");
    expect(bad.status).toBe(403);
    expect(await bad.json()).toEqual({ error: "invalid oauth state" });
  });
  it("does not reflect request input into the page", async () => {
    const marker = "REFLECT_ME_12345";
    const res = await get(`/api/oauth/callback?code=${marker}&state=${marker}`, "text/html");
    expect(await res.text()).not.toContain(marker);
  });
});
