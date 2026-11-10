import { describe, expect, it } from "vitest";
import { createOpenAiCompatibleAdapter } from "./openaiCompatible";
import { createProviderGateway } from "./gateway";
import { loadGatewayConfig } from "./config";

const KEY = "sk-SECRET-KEY-MARKER";
const ok = (tokens = { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }) => new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: tokens }), { status: 200, headers: { "content-type": "application/json" } });
const msgs = [{ role: "user" as const, content: "PROMPT-MARKER hello" }];
const baseEnv = { LLM_API_URL: "https://api.sarvam.ai", LLM_ENDPOINT_PROFILE: "sarvam-chat", LLM_MODEL: "m-1", LLM_API_KEY: KEY, GATEWAY_ALLOW_EXTERNAL: "true", GATEWAY_ALLOW_METERED: "true", GATEWAY_BUDGET_STORE: "memory", GATEWAY_EXTERNAL_MAX_REQUESTS_PER_DAY: "2", GATEWAY_EXTERNAL_MAX_TOKENS_PER_DAY: "1000", GATEWAY_EXTERNAL_MAX_COST_PER_DAY: "10", GATEWAY_COST_PER_1K_PROMPT_TOKENS: "0.015", GATEWAY_COST_PER_1K_COMPLETION_TOKENS: "0.06", GATEWAY_COST_UNIT: "INR", GATEWAY_MAX_ATTEMPTS: "1", GATEWAY_MAX_OUTPUT_TOKENS: "100" };
const mk = (env: Record<string, string>, fetchImpl: typeof fetch) => createProviderGateway(loadGatewayConfig(env), { log: () => undefined, adapterFactory: (b) => createOpenAiCompatibleAdapter({ providerId: b.providerId, baseUrl: b.baseUrl, endpointProfile: b.endpointProfile, apiKey: b.apiKey, maxAttempts: 1, fetchImpl }) });

describe("gateway runtime snapshot (read-only, tenant-scoped, secret-free)", () => {
  it("reports providers, remaining budget, denials and recent calls for one workspace only", async () => {
    const g = mk(baseEnv, (async () => ok()) as unknown as typeof fetch);
    expect((await g.invoke({ requestId: "a", workspaceId: 1, messages: msgs })).status).toBe("returned");
    expect((await g.invoke({ requestId: "b", workspaceId: 1, messages: msgs })).status).toBe("returned");
    const third = await g.invoke({ requestId: "c", workspaceId: 1, messages: msgs });
    expect(third).toMatchObject({ status: "failed", reason: "budget_denied" });
    await g.invoke({ requestId: "d", workspaceId: 2, messages: msgs });

    const s1 = await g.runtimeSnapshot(1);
    const ext = s1.providers.find((p) => p.providerId === "external-openai-compatible")!;
    expect(ext).toMatchObject({ runtimeClass: "hosted", modelId: "m-1", endpointProfile: "sarvam-chat", kind: "external", billingMode: "metered_api", eligibleForWorkspace: true });
    expect(s1.providers.find((p) => p.providerId === "local-openai-compatible")).toMatchObject({ state: "disabled", eligibleForWorkspace: false });
    expect(s1.workspace.usageToday).toMatchObject({ requests: 2, tokens: 300 });
    expect(s1.workspace.remaining).toMatchObject({ requests: 0, tokens: 700 });
    expect(s1.workspace.costUnit).toBe("INR"); expect(s1.workspace.costBasis).toMatch(/not an invoice/);
    expect(s1.counters).toMatchObject({ budget_denied: 1, returned: 3 });
    expect(s1.recent.map((r) => r.status)).toEqual(["failed", "returned", "returned"]);
    expect(s1.recent[0].reason).toBe("budget_denied");
    // another workspace sees none of workspace 1's calls
    const s2 = await g.runtimeSnapshot(2);
    expect(s2.recent).toHaveLength(1); expect(s2.workspace.usageToday).toMatchObject({ requests: 1 });
    // nothing sensitive
    const text = JSON.stringify(s1);
    expect(text).not.toMatch(/SECRET|PROMPT-MARKER|api\.sarvam\.ai|https?:\/\//);
  });
  it("records a fallback from a failing local provider to the external one", async () => {
    const f = (async (url: any) => (String(url).startsWith("http://127.0.0.1") ? new Response("x", { status: 500 }) : ok())) as unknown as typeof fetch;
    const g = mk({ ...baseEnv, LOCAL_LLM_API_URL: "http://127.0.0.1:9", LOCAL_LLM_MODEL: "loc", LLM_ENDPOINT_PROFILE: "", LLM_API_URL: "https://api.example.com" }, f);
    const r = await g.invoke({ requestId: "x", workspaceId: 1, messages: msgs });
    expect(r).toMatchObject({ status: "returned", providerId: "external-openai-compatible" });
    const s = await g.runtimeSnapshot(1);
    expect(s.counters.fellBack).toBe(1); expect(s.recent[0]).toMatchObject({ fellBack: true });
    expect(s.recent[0].sequence).toEqual(["local-openai-compatible:server_error", "external-openai-compatible:ok"]);
  });
  it("shows a disabled external provider with the configuration reason, and no eligibility", async () => {
    const g = mk({ ...baseEnv, LLM_API_URL: "https://evil.example" }, (async () => ok()) as unknown as typeof fetch);
    const ext = (await g.runtimeSnapshot(1)).providers.find((p) => p.providerId === "external-openai-compatible")!;
    expect(ext.state).toBe("invalid_configuration"); expect(ext.invalidReason).toMatch(/host is not allowed/); expect(ext.eligibleForWorkspace).toBe(false);
    expect(JSON.stringify(ext)).not.toContain("evil.example");
  });
  it("a policy-resolver failure is reported, not hidden, and fabricates no remaining budget", async () => {
    const g = createProviderGateway(loadGatewayConfig(baseEnv), { log: () => undefined, policyResolver: { resolve: async () => { throw new Error("db down"); } }, adapterFactory: () => ({ providerId: "x", complete: async () => { throw new Error("no"); } }) });
    const s = await g.runtimeSnapshot(1);
    expect(s.workspace.policyError).toBe(true); expect(s.workspace.remaining).toBeNull(); expect(s.workspace.policy).toBeNull();
  });
});
