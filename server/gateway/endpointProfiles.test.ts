import { describe, expect, it } from "vitest";
import { loadGatewayConfig, EXTERNAL_PROVIDER_ID } from "./config";
import { validatePinnedOrigin } from "./endpointProfiles";
import { createOpenAiCompatibleAdapter } from "./openaiCompatible";
import { createProviderGateway } from "./gateway";
import { modelCallMeta } from "./provenance";

const KEY = "sk-SECRET-KEY-MARKER";
const ext = (extra: Record<string, string>) => ({ LLM_MODEL: "m", LLM_API_KEY: KEY, ...extra });
const okBody = { choices: [{ message: { content: "வணக்கம்" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
const fakeFetch = (calls: Array<{ url: string; init: any }>) => (async (url: any, init: any) => { calls.push({ url: String(url), init }); return new Response(JSON.stringify(okBody), { status: 200, headers: { "content-type": "application/json" } }); }) as unknown as typeof fetch;
const msgs = [{ role: "user" as const, content: "hi" }];

describe("endpoint profile configuration", () => {
  it("unset profile keeps the historical behaviour exactly", () => {
    const c = loadGatewayConfig(ext({ LLM_API_URL: "https://api.example.com" }));
    expect(c.invalid).toEqual([]);
    expect(c.bindings[0]).toMatchObject({ providerId: EXTERNAL_PROVIDER_ID, baseUrl: "https://api.example.com", endpointProfile: "openai-v1" });
  });
  it("accepts the pinned origins only", () => {
    for (const [profile, url] of [["gemini-openai", "https://generativelanguage.googleapis.com"], ["sarvam-chat", "https://api.sarvam.ai/"], ["sarvam-chat", "https://API.SARVAM.AI"]] as const) {
      const c = loadGatewayConfig(ext({ LLM_API_URL: url, LLM_ENDPOINT_PROFILE: profile }));
      expect(c.invalid, `${profile} ${url}`).toEqual([]);
      expect(c.bindings[0].endpointProfile).toBe(profile);
    }
  });
  it.each([
    ["http scheme", "gemini-openai", "http://generativelanguage.googleapis.com"],
    ["wrong host", "gemini-openai", "https://api.sarvam.ai"],
    ["lookalike suffix", "gemini-openai", "https://generativelanguage.googleapis.com.evil.example"],
    ["lookalike prefix", "sarvam-chat", "https://evilapi.sarvam.ai"],
    ["userinfo trick", "gemini-openai", "https://generativelanguage.googleapis.com@evil.example"],
    ["credentials", "sarvam-chat", "https://u:p@api.sarvam.ai"],
    ["custom port", "sarvam-chat", "https://api.sarvam.ai:8443"],
    ["extra path", "gemini-openai", "https://generativelanguage.googleapis.com/v1beta/openai"],
    ["query", "sarvam-chat", "https://api.sarvam.ai/?x=1"],
    ["fragment", "sarvam-chat", "https://api.sarvam.ai/#x"],
    ["loopback", "sarvam-chat", "http://localhost:11434"],
  ])("refuses %s", (_n, profile, url) => {
    const c = loadGatewayConfig(ext({ LLM_API_URL: url, LLM_ENDPOINT_PROFILE: profile }));
    expect(c.bindings).toEqual([]);
    expect(c.invalid[0].providerId).toBe(EXTERNAL_PROVIDER_ID);
  });
  it("an unrecognised profile name is refused, not defaulted", () => {
    const c = loadGatewayConfig(ext({ LLM_API_URL: "https://api.example.com", LLM_ENDPOINT_PROFILE: "gemini" }));
    expect(c.bindings).toEqual([]); expect(c.invalid[0].reason).toMatch(/not a recognised profile/);
  });
  it("the local binding never takes a profile (a hosted API cannot be placed in the local slot via a profile)", () => {
    const c = loadGatewayConfig({ LOCAL_LLM_API_URL: "http://localhost:11434", LOCAL_LLM_MODEL: "x", LLM_ENDPOINT_PROFILE: "sarvam-chat" });
    expect(c.bindings[0].endpointProfile).toBeUndefined();
  });
  it("validatePinnedOrigin returns only the allowlisted origin", () => {
    expect(validatePinnedOrigin("gemini-openai", "https://generativelanguage.googleapis.com")).toEqual({ ok: true, origin: "https://generativelanguage.googleapis.com" });
    expect(validatePinnedOrigin("sarvam-chat", "https://API.sarvam.ai/")).toEqual({ ok: true, origin: "https://api.sarvam.ai" });
  });
});

describe("endpoint profile adapter behaviour", () => {
  it("pinned profile calls the fixed URL with Bearer auth, disables redirects, and sends only model/messages/max_tokens", async () => {
    const calls: Array<{ url: string; init: any }> = [];
    const a = createOpenAiCompatibleAdapter({ providerId: "p", baseUrl: "https://generativelanguage.googleapis.com", endpointProfile: "gemini-openai", apiKey: KEY, fetchImpl: fakeFetch(calls) });
    const r = await a.complete({ messages: msgs, model: "gemini-x", maxOutputTokens: 64 });
    expect(r.content).toBe("வணக்கம்");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
    expect(calls[0].init.redirect).toBe("error");
    expect(calls[0].init.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(calls[0].init.body)).toEqual({ model: "gemini-x", messages: msgs, max_tokens: 64 });
  });
  it("default profile keeps the old URL and body, and also refuses redirects", async () => {
    const calls: Array<{ url: string; init: any }> = [];
    const a = createOpenAiCompatibleAdapter({ providerId: "p", baseUrl: "https://api.example.com", fetchImpl: fakeFetch(calls) });
    await a.complete({ messages: msgs, model: "m" });
    expect(calls[0].url).toBe("https://api.example.com/v1/chat/completions");
    expect(JSON.parse(calls[0].init.body)).toEqual({ model: "m", messages: msgs });
    expect(calls[0].init.redirect).toBe("error");
  });
  it("a pinned adapter refuses a non-allowlisted base URL at construction (defence in depth beyond config)", () => {
    expect(() => createOpenAiCompatibleAdapter({ providerId: "p", baseUrl: "https://evil.example", endpointProfile: "sarvam-chat", apiKey: KEY })).toThrow(/refused the configured base URL/);
  });
  it("a redirect response is a failure and never reaches another host", async () => {
    const calls: string[] = [];
    const f = (async (url: any, init: any) => { calls.push(String(url)); if (init.redirect === "error") throw new TypeError("redirect mode is set to error"); return new Response("{}"); }) as unknown as typeof fetch;
    const a = createOpenAiCompatibleAdapter({ providerId: "p", baseUrl: "https://api.sarvam.ai", endpointProfile: "sarvam-chat", apiKey: KEY, fetchImpl: f, maxAttempts: 1 });
    await expect(a.complete({ messages: msgs, model: "m" })).rejects.toMatchObject({ errorClass: "network" });
    expect(calls).toEqual(["https://api.sarvam.ai/v1/chat/completions"]);
  });
});

describe("gateway integration (policy and budget preserved; profile is a label, never a URL)", () => {
  const env = ext({ LLM_API_URL: "https://api.sarvam.ai", LLM_ENDPOINT_PROFILE: "sarvam-chat", LLM_MODEL: "sarvam-105b", GATEWAY_ALLOW_EXTERNAL: "true", GATEWAY_ALLOW_METERED: "true", GATEWAY_BUDGET_STORE: "memory", GATEWAY_EXTERNAL_MAX_REQUESTS_PER_DAY: "1", GATEWAY_COST_PER_1K_PROMPT_TOKENS: "0.015", GATEWAY_COST_PER_1K_COMPLETION_TOKENS: "0.06", GATEWAY_COST_UNIT: "INR" });
  const mk = (e: Record<string, string>, calls: Array<{ url: string; init: any }>) => createProviderGateway(loadGatewayConfig(e), { log: () => undefined, adapterFactory: (b, c) => createOpenAiCompatibleAdapter({ providerId: b.providerId, baseUrl: b.baseUrl, endpointProfile: b.endpointProfile, apiKey: b.apiKey, maxAttempts: 1, fetchImpl: fakeFetch(calls) }) });
  it("returns the profile label, a gateway-computed cost, and enforces the per-day request ceiling", async () => {
    const calls: Array<{ url: string; init: any }> = [];
    const g = mk(env, calls);
    const r = await g.invoke({ requestId: "r1", workspaceId: 1, messages: msgs });
    expect(r).toMatchObject({ status: "returned", providerId: EXTERNAL_PROVIDER_ID, modelId: "sarvam-105b", endpointProfile: "sarvam-chat" });
    if (r.status === "returned") expect(r.usage.cost).toMatchObject({ unit: "INR", estimated: false });
    const second = await g.invoke({ requestId: "r2", workspaceId: 1, messages: msgs });
    expect(second).toMatchObject({ status: "failed", reason: "budget_denied" });
    expect(calls).toHaveLength(1);
    const st = (await g.status()).find((s) => s.providerId === EXTERNAL_PROVIDER_ID)!;
    expect(st.endpointProfile).toBe("sarvam-chat");
    expect(JSON.stringify(st)).not.toMatch(/sarvam\.ai|SECRET/);
  });
  it("is still disabled by default: without GATEWAY_ALLOW_EXTERNAL nothing is sent", async () => {
    const calls: Array<{ url: string; init: any }> = [];
    const g = mk({ ...env, GATEWAY_ALLOW_EXTERNAL: "false" }, calls);
    const r = await g.invoke({ requestId: "r1", workspaceId: 1, messages: msgs });
    expect(r.status).toBe("failed"); expect(calls).toHaveLength(0);
  });
  it("provenance carries the new fields without an endpoint, key or prompt", async () => {
    const g = mk(env, []);
    const r = await g.invoke({ requestId: "corr-9", workspaceId: 1, messages: msgs });
    if (r.status !== "returned") throw new Error("expected returned");
    const m = modelCallMeta(r, { requestId: "corr-9", invokedAt: Date.UTC(2026, 9, 18, 6, 0, 0) })!;
    expect(m).toMatchObject({ runtimeClass: "hosted", endpointProfile: "sarvam-chat", correlationId: "corr-9", invokedAt: "2026-10-18T06:00:00.000Z", verification: "gateway_reported", fallbackOccurred: false });
    expect(m.usage.cost).toMatchObject({ unit: "INR", estimated: false });
    const text = JSON.stringify(m);
    expect(text).not.toMatch(/sarvam\.ai|SECRET|hi"/);
  });
  it("fallbackOccurred and runtimeClass=local are derived from the outcome", () => {
    const base = { status: "returned" as const, content: "x", providerId: "local-openai-compatible", modelId: "q", profileId: "p", kind: "self_hosted" as const, billingMode: "local_compute" as const, usage: { source: "none" as const }, latencyMs: 1 };
    expect(modelCallMeta({ ...base, attempts: [{ providerId: "local-openai-compatible", outcome: "ok" }] })).toMatchObject({ runtimeClass: "local", fallbackOccurred: false });
    expect(modelCallMeta({ ...base, attempts: [{ providerId: "external-openai-compatible", outcome: "timeout" }, { providerId: "local-openai-compatible", outcome: "ok" }] })).toMatchObject({ fallbackOccurred: true });
  });
});
