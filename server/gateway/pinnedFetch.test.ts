import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPinnedFetch, localSlotAddressPolicy, PinnedFetchRefusal } from "./pinnedFetch";

/**
 * Real sockets on 127.0.0.1. The resolver is injected, so "DNS" answers are scripted per call; what is proven is which address the SOCKET dials and how many
 * times the name is resolved, not what a resolver library does.
 */
type Seen = { host: string | undefined; body: string; headers: http.IncomingHttpHeaders };
let server: http.Server;
let port = 0;
let seen: Seen[] = [];
let behaviour: "ok" | "redirect" | "slow" | "empty" = "ok";
let decoyHits = 0;
let decoy: http.Server;
let decoyPort = 0;

beforeAll(async () => {
  decoy = http.createServer((_req, res) => { decoyHits++; res.end("decoy"); });
  await new Promise<void>((r) => decoy.listen(0, "127.0.0.1", r));
  decoyPort = (decoy.address() as AddressInfo).port;
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen.push({ host: req.headers.host, body: Buffer.concat(chunks).toString("utf8"), headers: req.headers });
      if (behaviour === "redirect") { res.writeHead(302, { location: `http://127.0.0.1:${decoyPort}/stolen` }); res.end(); return; }
      if (behaviour === "empty") { res.writeHead(204); res.end(); return; }
      if (behaviour === "slow") { setTimeout(() => { try { res.end("late"); } catch { /* aborted */ } }, 1500); return; }
      res.writeHead(200, { "content-type": "application/json", "retry-after": "3" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => { await new Promise((r) => server.close(r)); await new Promise((r) => decoy.close(r)); });

const reset = () => { seen = []; behaviour = "ok"; decoyHits = 0; };
const scripted = (answers: string[][]) => { const calls: string[] = []; return { calls, resolve: async (h: string) => { calls.push(h); return answers[Math.min(calls.length - 1, answers.length - 1)]!; } }; };

describe("createPinnedFetch with the local-slot policy", () => {
  it("dials the validated address (not whatever the name means later) and sends the real Host header, body and identity encoding", async () => {
    reset();
    const dns = scripted([["127.0.0.1"]]);
    const f = createPinnedFetch({ policy: localSlotAddressPolicy, resolve: dns.resolve });
    const res = await f(`http://ollama.internal:${port}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer k" }, body: JSON.stringify({ a: 1 }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get("retry-after")).toBe("3");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.host).toBe(`ollama.internal:${port}`);
    expect(seen[0]!.body).toBe('{"a":1}');
    expect(seen[0]!.headers["accept-encoding"]).toBe("identity");
    expect(seen[0]!.headers["content-length"]).toBe("7");
    expect(dns.calls).toEqual(["ollama.internal"]);
  });

  it("DNS rebinding: a name that flips to the metadata address after the first answer is resolved ONCE per connection, so the flip is never dialled", async () => {
    reset();
    const dns = scripted([["127.0.0.1"], ["169.254.169.254"]]);
    const f = createPinnedFetch({ policy: localSlotAddressPolicy, resolve: dns.resolve });
    const first = await f(`http://rebind.internal:${port}/`, { method: "POST", body: "x" });
    expect(first.status).toBe(200);
    expect(dns.calls).toHaveLength(1); // one resolution for the one connection: there is no second lookup to race
    // the NEXT connection re-validates and sees the flipped answer: refused before any packet is sent
    await expect(f(`http://rebind.internal:${port}/`, { method: "POST", body: "x" })).rejects.toBeInstanceOf(PinnedFetchRefusal);
    expect(dns.calls).toHaveLength(2);
    expect(seen).toHaveLength(1);
  });

  it.each([
    ["metadata", ["169.254.169.254"]], ["link-local", ["169.254.1.1"]], ["fe80", ["fe80::1"]], ["mapped metadata", ["::ffff:a9fe:a9fe"]], ["nat64 metadata", ["64:ff9b::a9fe:a9fe"]],
    ["aws ipv6 imds", ["fd00:ec2::254"]], ["alibaba", ["100.100.100.200"]], ["public", ["93.184.216.34"]], ["mixed loopback + public", ["127.0.0.1", "93.184.216.34"]],
    ["mixed loopback + metadata", ["127.0.0.1", "169.254.169.254"]], ["metadata first", ["169.254.169.254", "127.0.0.1"]], ["unspecified", ["0.0.0.0"]], ["empty answer", []],
  ])("refuses a name whose answer is %s, before any connection is made", async (_label, answer) => {
    reset();
    const f = createPinnedFetch({ policy: localSlotAddressPolicy, resolve: async () => answer });
    await expect(f(`http://victim.internal:${port}/`, { method: "POST", body: "secret prompt" })).rejects.toBeInstanceOf(PinnedFetchRefusal);
    expect(seen).toHaveLength(0);
  });

  it("a resolver failure is a refusal, not a fallback to the system resolver", async () => {
    reset();
    const f = createPinnedFetch({ policy: localSlotAddressPolicy, resolve: async () => { throw new Error("SERVFAIL"); } });
    await expect(f(`http://victim.internal:${port}/`)).rejects.toBeInstanceOf(PinnedFetchRefusal);
  });

  it("IP literals are judged by the same policy without any lookup", async () => {
    reset();
    const dns = scripted([["127.0.0.1"]]);
    const f = createPinnedFetch({ policy: localSlotAddressPolicy, resolve: dns.resolve });
    for (const url of ["http://169.254.169.254/latest/meta-data", "http://[::ffff:169.254.169.254]/", "http://[fe80::1]/", "http://8.8.8.8/", "http://2852039166/", "http://[fd00:ec2::254]/"]) {
      await expect(f(url, { method: "POST", body: "x" }), url).rejects.toBeInstanceOf(PinnedFetchRefusal);
    }
    expect(dns.calls).toEqual([]);
    const ok = await f(`http://127.0.0.1:${port}/`, { method: "POST", body: "x" });
    expect(ok.status).toBe(200);
    expect(dns.calls).toEqual([]);
  });

  it("the caller's own terminal error class is raised when a factory is supplied", async () => {
    class Terminal extends Error { constructor(readonly why: string) { super("terminal"); } }
    const f = createPinnedFetch({ policy: localSlotAddressPolicy, resolve: async () => ["169.254.169.254"], refusal: (why) => new Terminal(why) });
    const error = await f(`http://victim.internal:${port}/`).catch((e) => e);
    expect(error).toBeInstanceOf(Terminal);
    expect((error as Terminal).why).toMatch(/metadata/);
    expect(String((error as Error).message)).not.toMatch(/victim|169\.254/); // nothing about the destination in the message
  });

  it("never follows a redirect: it is a network failure and the redirect target receives nothing", async () => {
    reset(); behaviour = "redirect";
    const f = createPinnedFetch({ policy: localSlotAddressPolicy, resolve: async () => ["127.0.0.1"] });
    await expect(f(`http://ollama.internal:${port}/`, { method: "POST", body: "prompt" })).rejects.toBeInstanceOf(TypeError);
    expect(seen).toHaveLength(1);
    expect(decoyHits).toBe(0);
  });

  it("an abort signal stops the request (AbortError)", async () => {
    reset(); behaviour = "slow";
    const f = createPinnedFetch({ policy: localSlotAddressPolicy, resolve: async () => ["127.0.0.1"] });
    const controller = new AbortController();
    const pending = f(`http://ollama.internal:${port}/`, { method: "POST", body: "x", signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    const error = await pending.catch((e) => e);
    expect((error as { name?: string }).name).toBe("AbortError");
  });

  it("a body-less status (204) yields a Response whose body can be cancelled, as the adapters do on errors", async () => {
    reset(); behaviour = "empty";
    const f = createPinnedFetch({ policy: localSlotAddressPolicy, resolve: async () => ["127.0.0.1"] });
    const res = await f(`http://ollama.internal:${port}/`, { method: "POST", body: "x" });
    expect(res.status).toBe(204);
    await res.body?.cancel();
  });

  it("rejects unsupported protocols and request bodies instead of guessing", async () => {
    const f = createPinnedFetch({ policy: localSlotAddressPolicy, resolve: async () => ["127.0.0.1"] });
    await expect(f("ftp://ollama.internal/")).rejects.toThrow(/protocol/);
    await expect(f(`http://ollama.internal:${port}/`, { method: "POST", body: new URLSearchParams({ a: "b" }) })).rejects.toThrow(/body/);
  });
});

describe("localSlotAddressPolicy", () => {
  it("allows loopback and private only", () => {
    for (const ok of ["127.0.0.1", "::1", "10.1.2.3", "192.168.0.9", "100.64.0.1", "fd12::1", "::ffff:10.0.0.1"]) expect(localSlotAddressPolicy(ok, "h"), ok).toBeNull();
    for (const bad of ["169.254.169.254", "fe80::1", "8.8.8.8", "0.0.0.0", "2001:4860:4860::8888", "::ffff:8.8.8.8", "::ffff:a9fe:a9fe"]) expect(localSlotAddressPolicy(bad, "h"), bad).not.toBeNull();
  });
});

/** https: the connection is pinned to the validated address, but the certificate is still verified against the NAME the caller asked for. */
const hasOpenssl = (() => { try { execFileSync("openssl", ["version"], { stdio: "ignore" }); return true; } catch { return false; } })();
describe.skipIf(!hasOpenssl)("createPinnedFetch over https", () => {
  let dir = ""; let tlsServer: https.Server; let tlsPort = 0; let cert = "";
  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "pinned-tls-"));
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(dir, "k.pem"), "-out", path.join(dir, "c.pem"), "-days", "2", "-subj", "/CN=llm.internal", "-addext", "subjectAltName=DNS:llm.internal"], { stdio: "ignore" });
    cert = readFileSync(path.join(dir, "c.pem"), "utf8");
    tlsServer = https.createServer({ key: readFileSync(path.join(dir, "k.pem")), cert }, (_rq, rs) => { rs.writeHead(200, { "content-type": "application/json" }); rs.end('{"tls":true}'); });
    await new Promise<void>((r) => tlsServer.listen(0, "127.0.0.1", r));
    tlsPort = (tlsServer.address() as AddressInfo).port;
  });
  afterAll(async () => { await new Promise((r) => tlsServer.close(r)); rmSync(dir, { recursive: true, force: true }); });

  it("connects to the pinned loopback address and verifies the certificate for the requested name", async () => {
    const f = createPinnedFetch({ policy: localSlotAddressPolicy, resolve: async () => ["127.0.0.1"], tls: { ca: cert } });
    const res = await f(`https://llm.internal:${tlsPort}/`, { method: "POST", body: "x" });
    expect(await res.json()).toEqual({ tls: true });
  });

  it("a certificate that does not match the requested name fails, even though the pinned address answers", async () => {
    const f = createPinnedFetch({ policy: localSlotAddressPolicy, resolve: async () => ["127.0.0.1"], tls: { ca: cert } });
    await expect(f(`https://other.internal:${tlsPort}/`, { method: "POST", body: "x" })).rejects.toThrow();
  });

  it("without the CA the self-signed certificate is rejected (verification is on by default)", async () => {
    const f = createPinnedFetch({ policy: localSlotAddressPolicy, resolve: async () => ["127.0.0.1"] });
    await expect(f(`https://llm.internal:${tlsPort}/`, { method: "POST", body: "x" })).rejects.toThrow();
  });

  it("a metadata answer is refused before any TLS handshake", async () => {
    const f = createPinnedFetch({ policy: localSlotAddressPolicy, resolve: async () => ["169.254.169.254"], tls: { ca: cert } });
    await expect(f(`https://llm.internal:${tlsPort}/`)).rejects.toBeInstanceOf(PinnedFetchRefusal);
  });
});
