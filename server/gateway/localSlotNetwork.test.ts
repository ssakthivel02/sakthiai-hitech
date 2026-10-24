import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadGatewayConfig } from "./config";
import { createProviderGateway } from "./gateway";
import { createOpenAiCompatibleAdapter } from "./openaiCompatible";
import { ProviderCallError, type GatewayRequest } from "./types";

/**
 * Network behaviour of the LOCAL slot using the gateway's DEFAULT adapter wiring (no adapterFactory override), so the wiring in gateway.ts is what is
 * under test: redirects are never followed for a self-hosted binding, and a binding configured by name is refused unless every resolved address is
 * loopback/private. Only 127.0.0.1 is ever contacted; anything else fails the test.
 */
const req: GatewayRequest = { requestId: "r1", workspaceId: 1, messages: [{ role: "user", content: "SECRET-PROMPT-123" }] };
const OKBODY = JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] });

type Srv = { port: number; hits: Array<{ url: string; body: string }>; close: () => Promise<void> };
const open: Srv[] = [];
async function serve(handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void): Promise<Srv> {
  const hits: Srv["hits"] = [];
  const server = http.createServer((rq, rs) => {
    const chunks: Buffer[] = [];
    rq.on("data", (c) => chunks.push(c));
    rq.on("end", () => { const body = Buffer.concat(chunks).toString("utf8"); hits.push({ url: rq.url ?? "", body }); handler(rq, rs, body); });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const s: Srv = { port: (server.address() as AddressInfo).port, hits, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
  open.push(s);
  return s;
}
const okHandler = (_rq: http.IncomingMessage, rs: http.ServerResponse) => { rs.writeHead(200, { "content-type": "application/json" }); rs.end(OKBODY); };

const realFetch = globalThis.fetch;
let fetchCalls: string[] = [];
beforeAll(() => {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String((input as { url?: string })?.url ?? input);
    fetchCalls.push(url);
    if (!/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url)) throw new Error(`TEST GUARD: non-loopback request attempted: ${url}`);
    return realFetch(input as RequestInfo, init);
  }) as typeof fetch;
});
afterAll(() => { globalThis.fetch = realFetch; });
afterEach(async () => { fetchCalls = []; await Promise.all(open.splice(0).map((s) => s.close())); });

const gatewayFor = (env: Record<string, string>) => createProviderGateway(loadGatewayConfig({ GATEWAY_TIMEOUT_MS: "2000", GATEWAY_MAX_ATTEMPTS: "1", ...env }));

describe("loopback Ollama-style inference keeps working through the default wiring", () => {
  it.each([["127.0.0.1", ""], ["127.0.0.1", "/v1"], ["localhost", ""]])("http://%s:PORT%s → returned from the local provider, no policy flags or budget needed", async (host, suffix) => {
    const srv = await serve(okHandler);
    const out = await gatewayFor({ LOCAL_LLM_API_URL: `http://${host}:${srv.port}${suffix}`, LOCAL_LLM_MODEL: "llama3" }).invoke(req);
    expect(out).toMatchObject({ status: "returned", content: "ok", kind: "self_hosted", billingMode: "local_compute" });
    expect(srv.hits).toHaveLength(1);
  });
});

describe("a self-hosted endpoint can never re-send the prompt elsewhere by redirect", () => {
  it.each([301, 302, 307, 308])("HTTP %i from the local endpoint is not followed; the other destination receives nothing", async (status) => {
    const other = await serve(okHandler);
    const front = await serve((_rq, rs) => { rs.writeHead(status, { location: `http://127.0.0.1:${other.port}/elsewhere` }); rs.end(); });
    const out = await gatewayFor({ LOCAL_LLM_API_URL: `http://127.0.0.1:${front.port}`, LOCAL_LLM_MODEL: "m" }).invoke(req);
    expect(out.status).not.toBe("returned");
    expect(front.hits).toHaveLength(1);
    expect(other.hits).toHaveLength(0);
    expect(JSON.stringify(out)).not.toContain("SECRET-PROMPT-123");
  });
});

describe("a self-hosted endpoint configured by NAME is resolved and checked before any request", () => {
  it("an approved private name that does not resolve to a private address is refused and no request leaves the gateway", async () => {
    const out = await gatewayFor({ LOCAL_LLM_API_URL: "http://ghost-box-does-not-exist.lan:1", LOCAL_LLM_MODEL: "m", LOCAL_LLM_ALLOWED_HOSTS: "ghost-box-does-not-exist.lan" }).invoke(req);
    expect(out.status).not.toBe("returned");
    expect(fetchCalls).toHaveLength(0);
  });
});

describe("adapter host guard", () => {
  const mk = (hostGuard: (h: string) => Promise<boolean>, fetchImpl: typeof fetch) =>
    createOpenAiCompatibleAdapter({ providerId: "local-openai-compatible", baseUrl: "http://ollama.internal:11434", timeoutMs: 1000, maxAttempts: 3, hostGuard, fetchImpl, sleep: async () => undefined, noRedirect: true });
  const call = { model: "m", messages: req.messages } as never;

  it("a refusing guard sends nothing, fails terminally (no retry, no fallback masking) and names no host", async () => {
    let fetches = 0;
    const adapter = mk(async () => false, (async () => { fetches += 1; return new Response(OKBODY); }) as typeof fetch);
    const err = await adapter.complete(call).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderCallError);
    expect(err.errorClass).toBe("bad_request");
    expect(String(err.message)).not.toMatch(/ollama|11434/);
    expect(fetches).toBe(0);
  });

  it("an approving guard lets the request through, with redirect refused", async () => {
    let seen: RequestInit | undefined;
    let guarded = "";
    const adapter = mk(async (h) => { guarded = h; return true; }, (async (_u: unknown, init?: RequestInit) => { seen = init; return new Response(OKBODY); }) as typeof fetch);
    expect(await adapter.complete(call)).toMatchObject({ content: "ok" });
    expect(guarded).toBe("ollama.internal");
    expect(seen?.redirect).toBe("error");
  });

  it("a guard that never answers is bounded by the attempt timeout", async () => {
    const adapter = createOpenAiCompatibleAdapter({ providerId: "p", baseUrl: "http://ollama.internal:11434", timeoutMs: 50, maxAttempts: 1, hostGuard: () => new Promise<boolean>(() => undefined), fetchImpl: (async () => new Response(OKBODY)) as typeof fetch });
    const err = await adapter.complete(call).catch((e) => e);
    expect(err.errorClass).toBe("timeout");
  });

  it("without the local-slot options the adapter still refuses redirects (every binding, every profile)", async () => {
    let seen: RequestInit | undefined;
    const adapter = createOpenAiCompatibleAdapter({ providerId: "p", baseUrl: "https://api.example.com", fetchImpl: (async (_u: unknown, init?: RequestInit) => { seen = init; return new Response(OKBODY); }) as typeof fetch });
    await adapter.complete(call);
    expect(seen?.redirect).toBe("error");
  });
});
