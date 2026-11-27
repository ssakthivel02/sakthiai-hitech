import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryBudgetStore, type BudgetStore, type WorkspaceBudgetPolicy } from "./budget";
import { loadGatewayConfig, EXTERNAL_PROVIDER_ID, LOCAL_PROVIDER_ID } from "./config";
import { createProviderGateway, type GatewayDependencies } from "./gateway";
import { createOpenAiCompatibleAdapter } from "./openaiCompatible";
import type { GatewayRequest } from "./types";

/**
 * Behavioural tests for the Provider Gateway. Real routing (server/model-fabric), real adapter, real
 * circuit breaker and real budget store run against deterministic fake OpenAI-compatible HTTP servers on
 * loopback. No paid or external provider can be reached; a global guard fails the test if a non-loopback
 * request is attempted.
 */

type Scripted = { status?: number; body?: unknown; raw?: string; delayMs?: number; headers?: Record<string, string> };
type FakeProvider = { url: string; script: Scripted[]; requests: Array<{ path: string; auth: string | undefined; body: any }>; sticky?: Scripted; close: () => Promise<void> };

const servers: FakeProvider[] = [];
const OK = (content: string, usage?: object): Scripted => ({ status: 200, body: { id: "x", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], ...(usage ? { usage } : {}) } });

async function fakeProvider(script: Scripted[] = [], sticky?: Scripted): Promise<FakeProvider> {
  const state: FakeProvider = { url: "", script, requests: [], sticky, close: async () => undefined };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      let body: any = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* keep null */ }
      state.requests.push({ path: req.url ?? "", auth: req.headers.authorization, body });
      const step = state.script.shift() ?? state.sticky ?? OK("default");
      const send = () => {
        if (res.destroyed) return;
        res.writeHead(step.status ?? 200, { "content-type": "application/json", ...(step.headers ?? {}) });
        res.end(step.raw !== undefined ? step.raw : JSON.stringify(step.body ?? {}));
      };
      if (step.delayMs) setTimeout(send, step.delayMs); else send();
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.close = () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
  servers.push(state);
  return state;
}

const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input?.url ?? input);
    if (!/^http:\/\/127\.0\.0\.1[:/]/.test(url)) throw new Error(`TEST GUARD: non-loopback request attempted: ${url}`);
    return realFetch(input, init);
  }) as typeof fetch;
});
afterAll(() => { globalThis.fetch = realFetch; });
afterEach(async () => { await Promise.all(servers.splice(0).map(s => s.close())); });

const messages: GatewayRequest["messages"] = [{ role: "system", content: "SECRET-PROMPT-MARKER evidence" }, { role: "user", content: "question?" }];
const request = (over: Partial<GatewayRequest> = {}): GatewayRequest => ({ requestId: "req-1", workspaceId: 1, messages, ...over });

let sleeps: number[] = [];
let logs: Array<Record<string, unknown>> = [];
beforeEach(() => { sleeps = []; logs = []; });

function build(env: Record<string, string>, deps: GatewayDependencies = {}) {
  const config = loadGatewayConfig({ GATEWAY_TIMEOUT_MS: "2000", GATEWAY_BACKOFF_BASE_MS: "10", ...env });
  return createProviderGateway(config, {
    log: entry => logs.push(entry),
    adapterFactory: (binding, cfg) => createOpenAiCompatibleAdapter({
      providerId: binding.providerId, baseUrl: binding.baseUrl, apiKey: binding.apiKey, timeoutMs: binding.timeoutMs,
      maxAttempts: cfg.retry.maxAttempts, totalDeadlineMs: cfg.retry.totalDeadlineMs, backoffBaseMs: cfg.retry.backoffBaseMs, backoffMaxMs: cfg.retry.backoffMaxMs,
      sleep: async ms => { sleeps.push(ms); }, random: () => 0.5,
    }),
    ...deps,
  });
}
const externalEnv = (url: string, extra: Record<string, string> = {}) => ({ LLM_API_URL: url, LLM_MODEL: "ext-model", LLM_API_KEY: "sk-SECRET-KEY-MARKER", GATEWAY_ALLOW_EXTERNAL: "true", GATEWAY_ALLOW_METERED: "true", GATEWAY_BUDGET_STORE: "memory", GATEWAY_EXTERNAL_MAX_REQUESTS_PER_DAY: "100", ...extra });
const localEnv = (url: string, extra: Record<string, string> = {}) => ({ LOCAL_LLM_API_URL: url, LOCAL_LLM_MODEL: "local-model", ...extra });

describe("success paths", () => {
  it("local success: routes to the local/self-hosted provider, posts to /v1/chat/completions, no budget involved", async () => {
    const local = await fakeProvider([OK("local answer", { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })]);
    const gateway = build(localEnv(local.url));
    const result = await gateway.invoke(request());
    expect(result).toMatchObject({ status: "returned", content: "local answer", providerId: LOCAL_PROVIDER_ID, kind: "self_hosted", billingMode: "local_compute", modelId: "local-model" });
    expect(local.requests).toHaveLength(1);
    expect(local.requests[0].path).toBe("/v1/chat/completions");
    expect(local.requests[0].body.model).toBe("local-model");
    expect(local.requests[0].body.messages).toEqual(messages);
    expect(result.status === "returned" && result.usage).toMatchObject({ source: "provider_reported", totalTokens: 15 });
  });

  it("honours a base URL that already ends in /v1 (Ollama/vLLM style) without doubling it", async () => {
    const local = await fakeProvider([OK("ok")]);
    const gateway = build(localEnv(`${local.url}/v1`));
    expect((await gateway.invoke(request())).status).toBe("returned");
    expect(local.requests[0].path).toBe("/v1/chat/completions");
  });

  it("external success via a fake endpoint, bearer key sent, usage recorded", async () => {
    const ext = await fakeProvider([OK("external answer", { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 })]);
    const gateway = build(externalEnv(ext.url));
    const result = await gateway.invoke(request());
    expect(result).toMatchObject({ status: "returned", content: "external answer", providerId: EXTERNAL_PROVIDER_ID, kind: "external", billingMode: "metered_api" });
    expect(ext.requests[0].auth).toBe("Bearer sk-SECRET-KEY-MARKER");
    expect(await gateway.budgetStore!.usage(1)).toMatchObject({ requests: 1, tokens: 120 });
  });

  it("prefers local over an eligible external provider (local-first)", async () => {
    const local = await fakeProvider([OK("local")]);
    const ext = await fakeProvider([OK("external")]);
    const gateway = build({ ...localEnv(local.url), ...externalEnv(ext.url) });
    const result = await gateway.invoke(request());
    expect(result.status === "returned" && result.providerId).toBe(LOCAL_PROVIDER_ID);
    expect(ext.requests).toHaveLength(0);
  });
});

describe("adapter failure classification", () => {
  const failClass = async (script: Scripted[], sticky?: Scripted, env: Record<string, string> = {}) => {
    const local = await fakeProvider(script, sticky);
    const gateway = build({ ...localEnv(local.url), ...env });
    const result = await gateway.invoke(request());
    return { result, local, gateway };
  };

  it("timeout -> timeout (no unbounded wait)", async () => {
    const { result, local } = await failClass([], { delayMs: 400, ...OK("late") }, { GATEWAY_TIMEOUT_MS: "60", GATEWAY_MAX_ATTEMPTS: "1" });
    expect(result).toMatchObject({ status: "failed", reason: "timeout" });
    expect(local.requests).toHaveLength(1);
  });

  it("network failure (connection refused) -> network", async () => {
    const dead = await fakeProvider();
    const url = dead.url; await dead.close();
    const gateway = build({ ...localEnv(url), GATEWAY_MAX_ATTEMPTS: "2" });
    expect(await gateway.invoke(request())).toMatchObject({ status: "failed", reason: "network" });
  });

  it("malformed JSON -> malformed_response, not retried", async () => {
    const { result, local } = await failClass([{ status: 200, raw: "{not json" }]);
    expect(result).toMatchObject({ status: "failed", reason: "malformed_response" });
    expect(local.requests).toHaveLength(1);
  });

  it("wrong-shape JSON and non-string content -> malformed_response", async () => {
    for (const body of [{}, { choices: [] }, { choices: [{}] }, { choices: [{ message: { content: ["x"] } }] }, { choices: [{ message: { content: 5 } }] }, [], "str"]) {
      const { result } = await failClass([{ status: 200, body }]);
      expect(result, JSON.stringify(body)).toMatchObject({ status: "failed", reason: "malformed_response" });
    }
  });

  it("empty / whitespace response -> empty_response", async () => {
    for (const content of ["", "   \n"]) {
      const { result } = await failClass([OK(content)]);
      expect(result).toMatchObject({ status: "failed", reason: "empty_response" });
    }
  });

  it.each([401, 403])("HTTP %s -> auth_failed: exactly one request, no retry, and NO fallback to an allowed external provider", async status => {
    const local = await fakeProvider([{ status, body: { error: "nope" } }]);
    const ext = await fakeProvider([OK("external must not be used")]);
    const gateway = build({ ...localEnv(local.url), ...externalEnv(ext.url) });
    const result = await gateway.invoke(request());
    expect(result).toMatchObject({ status: "failed", reason: "auth_failed" });
    expect(local.requests).toHaveLength(1);
    expect(ext.requests).toHaveLength(0);
    expect(sleeps).toHaveLength(0);
  });

  it("other 4xx -> bad_request, not retried, no fallback", async () => {
    for (const status of [400, 404, 409, 422]) {
      const local = await fakeProvider([{ status, body: {} }]);
      const ext = await fakeProvider([OK("x")]);
      const result = await build({ ...localEnv(local.url), ...externalEnv(ext.url) }).invoke(request());
      expect(result, String(status)).toMatchObject({ status: "failed", reason: "bad_request" });
      expect(local.requests).toHaveLength(1);
      expect(ext.requests).toHaveLength(0);
    }
  });

  it("408 is retried and then succeeds", async () => {
    const { result, local } = await failClass([{ status: 408 }, OK("recovered")]);
    expect(result).toMatchObject({ status: "returned", content: "recovered" });
    expect(local.requests).toHaveLength(2);
    expect(result.attempts[0].httpAttempts).toBe(2);
  });

  it("429 honours Retry-After (bounded) and retries", async () => {
    const { result } = await failClass([{ status: 429, headers: { "retry-after": "2" } }, OK("after wait")]);
    expect(result.status).toBe("returned");
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThanOrEqual(2000);
  });

  it.each([500, 503])("HTTP %s then success -> retry success", async status => {
    const { result, local } = await failClass([{ status }, OK("ok after retry")]);
    expect(result).toMatchObject({ status: "returned", content: "ok after retry" });
    expect(local.requests).toHaveLength(2);
  });

  it("retry exhaustion is bounded: persistent 503 makes exactly maxAttempts requests", async () => {
    const { result, local } = await failClass([], { status: 503 }, { GATEWAY_MAX_ATTEMPTS: "3" });
    expect(result).toMatchObject({ status: "failed", reason: "server_error" });
    expect(local.requests).toHaveLength(3);
    expect(sleeps).toHaveLength(2);
  });

  it("backoff is jittered, exponential and capped; never exceeds the total deadline", async () => {
    const local = await fakeProvider([], { status: 503 });
    const gateway = build({ ...localEnv(local.url), GATEWAY_MAX_ATTEMPTS: "6", GATEWAY_BACKOFF_BASE_MS: "100", GATEWAY_BACKOFF_MAX_MS: "300" });
    await gateway.invoke(request());
    expect(sleeps).toHaveLength(5);
    for (const delay of sleeps) { expect(delay).toBeGreaterThan(0); expect(delay).toBeLessThanOrEqual(300); }
    expect(sleeps[0]).toBeLessThan(sleeps[2]); // 75 (=100*(0.5+0.25)) then 150 then 225...
    // Retry-After far beyond the deadline: give up instead of sleeping past it.
    const slow = await fakeProvider([], { status: 429, headers: { "retry-after": "3600" } });
    sleeps = [];
    const outcome = await build({ ...localEnv(slow.url), GATEWAY_TOTAL_DEADLINE_MS: "5000" }).invoke(request());
    expect(outcome).toMatchObject({ status: "failed", reason: "rate_limited" });
    expect(sleeps).toHaveLength(0);
    expect(slow.requests).toHaveLength(1);
  });
});

describe("policy, fallback and budget", () => {
  it("local unhealthy -> allowed external fallback, sequence recorded without prompts", async () => {
    const local = await fakeProvider([], { status: 503 });
    const ext = await fakeProvider([OK("fallback answer")]);
    const gateway = build({ ...localEnv(local.url), ...externalEnv(ext.url), GATEWAY_MAX_ATTEMPTS: "2" });
    const result = await gateway.invoke(request());
    expect(result).toMatchObject({ status: "returned", providerId: EXTERNAL_PROVIDER_ID, content: "fallback answer" });
    expect(result.attempts.map(a => `${a.providerId}:${a.outcome}`)).toEqual([`${LOCAL_PROVIDER_ID}:server_error`, `${EXTERNAL_PROVIDER_ID}:ok`]);
  });

  it("local failure with external fallback PROHIBITED -> failed, external never contacted", async () => {
    const local = await fakeProvider([], { status: 503 });
    const ext = await fakeProvider([OK("must not be called")]);
    const gateway = build({ ...localEnv(local.url), LLM_API_URL: ext.url, LLM_MODEL: "m", GATEWAY_MAX_ATTEMPTS: "1" }); // external configured but not allowed
    const result = await gateway.invoke(request());
    expect(result).toMatchObject({ status: "failed", reason: "server_error" });
    expect(ext.requests).toHaveLength(0);
  });

  it("an external provider alone is unusable until explicitly allowed (default deny)", async () => {
    const ext = await fakeProvider([OK("x")]);
    const gateway = build({ LLM_API_URL: ext.url, LLM_MODEL: "m", LLM_API_KEY: "k" });
    expect(await gateway.invoke(request())).toMatchObject({ status: "failed", reason: "no_eligible_provider" });
    expect(ext.requests).toHaveLength(0);
  });

  it("external allowed but metered-billing opt-in missing -> no call", async () => {
    const ext = await fakeProvider([OK("x")]);
    const gateway = build({ ...externalEnv(ext.url), GATEWAY_ALLOW_METERED: "false" });
    expect(await gateway.invoke(request())).toMatchObject({ status: "failed", reason: "no_eligible_provider" });
    expect(ext.requests).toHaveLength(0);
  });

  it("a subscription-billed external provider is ALSO denied until external use is explicitly allowed", async () => {
    const ext = await fakeProvider([OK("x")]);
    const gateway = build({ LLM_API_URL: ext.url, LLM_MODEL: "m", LLM_BILLING_MODE: "subscription" });
    expect(await gateway.invoke(request())).toMatchObject({ status: "failed", reason: "no_eligible_provider" });
    expect(ext.requests).toHaveLength(0);
  });

  it("a subscription-billed external provider does not need metered opt-in or a budget", async () => {
    const ext = await fakeProvider([OK("sub answer")]);
    const gateway = build({ LLM_API_URL: ext.url, LLM_MODEL: "m", LLM_BILLING_MODE: "subscription", GATEWAY_ALLOW_EXTERNAL: "true" });
    expect(await gateway.invoke(request())).toMatchObject({ status: "returned", content: "sub answer" });
  });

  it("budget exhausted -> metered provider is not called; falls back to local when available", async () => {
    const ext = await fakeProvider([], { ...OK("ext") });
    const gateway = build(externalEnv(ext.url, { GATEWAY_EXTERNAL_MAX_REQUESTS_PER_DAY: "1" }));
    expect((await gateway.invoke(request())).status).toBe("returned");
    const second = await gateway.invoke(request());
    expect(second).toMatchObject({ status: "failed", reason: "budget_denied" });
    expect(ext.requests).toHaveLength(1);
    expect(second.attempts[0].outcome).toBe("skipped:budget:requests_exhausted");

    const local = await fakeProvider([OK("local rescue")]);
    const both = build({ ...localEnv(local.url), ...externalEnv(ext.url, { GATEWAY_EXTERNAL_MAX_REQUESTS_PER_DAY: "1" }) });
    // local is preferred anyway; force the external path by making local fail permanently
    local.script.length = 0; local.sticky = { status: 503 };
    const r1 = await both.invoke(request());
    expect(r1.status === "returned" && r1.providerId).toBe(EXTERNAL_PROVIDER_ID); // budget 1 used
    const r2 = await both.invoke(request());
    expect(r2).toMatchObject({ status: "failed" });
  });

  it("token ceiling is enforced from the worst-case estimate before the call", async () => {
    const ext = await fakeProvider([OK("x")]);
    const gateway = build(externalEnv(ext.url, { GATEWAY_EXTERNAL_MAX_TOKENS_PER_DAY: "10", GATEWAY_EXTERNAL_MAX_REQUESTS_PER_DAY: "" }));
    expect(await gateway.invoke(request())).toMatchObject({ status: "failed", reason: "budget_denied" });
    expect(ext.requests).toHaveLength(0);
  });

  it("fails closed when a metered provider has no verifiable budget: no store, no limits, unavailable store, cost ceiling without rates", async () => {
    const ext = await fakeProvider([], OK("x"));
    const cases: Array<[string, Record<string, string>, GatewayDependencies?]> = [
      ["no store", externalEnv(ext.url, { GATEWAY_BUDGET_STORE: "none" })],
      ["no limits", externalEnv(ext.url, { GATEWAY_EXTERNAL_MAX_REQUESTS_PER_DAY: "" })],
      ["cost ceiling without configured rates", externalEnv(ext.url, { GATEWAY_EXTERNAL_MAX_REQUESTS_PER_DAY: "", GATEWAY_EXTERNAL_MAX_COST_PER_DAY: "5" })],
      ["store throws", externalEnv(ext.url), { budgetStore: { reserve: async () => { throw new Error("db down"); }, commit: async () => undefined, release: async () => undefined, usage: async () => ({ requests: 0, tokens: 0, cost: 0, estimatedCommits: 0 }) } }],
      ["policy resolver throws", externalEnv(ext.url), { policyResolver: { resolve: async () => { throw new Error("policy db down"); } } }],
    ];
    for (const [label, env, deps] of cases) {
      const result = await build(env, deps).invoke(request());
      expect(result, label).toMatchObject({ status: "failed", reason: "budget_denied" });
    }
    expect(ext.requests).toHaveLength(0);
  });

  it("cost is computed only from configured rates and provider-reported tokens; a cost ceiling is enforced", async () => {
    const ext = await fakeProvider([], OK("ok", { prompt_tokens: 1000, completion_tokens: 1000, total_tokens: 2000 }));
    const env = externalEnv(ext.url, { GATEWAY_COST_PER_1K_PROMPT_TOKENS: "0.5", GATEWAY_COST_PER_1K_COMPLETION_TOKENS: "1.5", GATEWAY_COST_UNIT: "credits", GATEWAY_EXTERNAL_MAX_COST_PER_DAY: "2.1", GATEWAY_EXTERNAL_MAX_REQUESTS_PER_DAY: "", GATEWAY_MAX_OUTPUT_TOKENS: "100" });
    const gateway = build(env);
    const first = await gateway.invoke(request());
    expect(first.status === "returned" && first.usage).toMatchObject({ source: "provider_reported", cost: { amount: 2, unit: "credits", basis: "configured_rate", estimated: false } });
    expect(await gateway.budgetStore!.usage(1)).toMatchObject({ cost: 2 });
    const second = await gateway.invoke(request());
    expect(second.status).toBe("failed"); // 2 spent + a worst-case estimate would exceed the ceiling of 2.1
    expect(ext.requests).toHaveLength(1);
  });

  it("usage is labelled estimated, never invented, when the provider reports none; local usage is never priced", async () => {
    const ext = await fakeProvider([OK("no usage block")]);
    const result = await build(externalEnv(ext.url)).invoke(request());
    expect(result.status === "returned" && result.usage.source).toBe("estimated");
    expect(result.status === "returned" && result.usage.cost).toBeUndefined();
    const local = await fakeProvider([OK("local no usage")]);
    const localResult = await build(localEnv(local.url)).invoke(request());
    expect(localResult.status === "returned" && localResult.usage).toEqual({ source: "none" });
  });

  it("no eligible model -> no_eligible_provider (nothing configured, nothing attempted)", async () => {
    const result = await build({}).invoke(request());
    expect(result).toMatchObject({ status: "failed", reason: "no_eligible_provider", attempts: [] });
  });

  it("a required capability no configured provider has -> no eligible model", async () => {
    const local = await fakeProvider([OK("x")]);
    const result = await build(localEnv(local.url)).invoke(request({ requiredCapabilities: ["vision"] }));
    expect(result).toMatchObject({ status: "failed", reason: "no_eligible_provider" });
    expect(local.requests).toHaveLength(0);
  });

  it("a provider is never tried twice in one request (no fallback loop) and candidates are bounded", async () => {
    const local = await fakeProvider([], { status: 503 });
    const ext = await fakeProvider([], { status: 503 });
    const gateway = build({ ...localEnv(local.url), ...externalEnv(ext.url), GATEWAY_MAX_ATTEMPTS: "1" });
    const result = await gateway.invoke(request());
    expect(result.status).toBe("failed");
    expect(local.requests).toHaveLength(1);
    expect(ext.requests).toHaveLength(1);
    expect(new Set(result.attempts.map(a => a.providerId)).size).toBe(result.attempts.length);
  });

  it("workspace identity reaches budget enforcement, and budgets/policies are per workspace", async () => {
    const ext = await fakeProvider([], OK("x"));
    const reserve = vi.fn();
    const store = new InMemoryBudgetStore();
    const spying: BudgetStore = { reserve: async input => { reserve(input.workspaceId, input.providerId, input.requestId); return store.reserve(input); }, commit: (r, a) => store.commit(r, a), release: r => store.release(r), usage: w => store.usage(w) };
    const policies: Record<number, WorkspaceBudgetPolicy> = { 1: { externalEnabled: true, maxRequests: 1 }, 2: { externalEnabled: true, maxRequests: 5 }, 3: { externalEnabled: false, maxRequests: 5 } };
    const gateway = build(externalEnv(ext.url), { budgetStore: spying, policyResolver: { resolve: async w => policies[w] } });
    expect((await gateway.invoke(request({ workspaceId: 1, requestId: "a" }))).status).toBe("returned");
    expect((await gateway.invoke(request({ workspaceId: 1, requestId: "b" }))).status).toBe("failed"); // workspace 1 exhausted
    expect((await gateway.invoke(request({ workspaceId: 2, requestId: "c" }))).status).toBe("returned"); // workspace 2 unaffected
    expect((await gateway.invoke(request({ workspaceId: 3, requestId: "d" }))).status).toBe("failed"); // external disabled for workspace 3
    expect(reserve.mock.calls.map(c => c[0])).toEqual([1, 1, 2, 3]);
    expect(reserve.mock.calls[0]).toEqual([1, EXTERNAL_PROVIDER_ID, "a"]);
    expect(await store.usage(1)).toMatchObject({ requests: 1 });
    expect(await store.usage(2)).toMatchObject({ requests: 1 });
    expect(await store.usage(3)).toMatchObject({ requests: 0 });
  });

  it("a failed call releases its budget hold, except where the provider may have billed (timeout/malformed/empty)", async () => {
    const ext = await fakeProvider([{ status: 401 }, { status: 429 }, { status: 503 }, { status: 503 }, { status: 503 }, { status: 503 }, { status: 503 }, { status: 503 }], OK("x"));
    const gateway = build(externalEnv(ext.url, { GATEWAY_MAX_ATTEMPTS: "1" }));
    await gateway.invoke(request()); // 401 -> released
    await gateway.invoke(request()); // 429 -> released
    expect(await gateway.budgetStore!.usage(1)).toMatchObject({ requests: 0, tokens: 0 });
    const malformed = await fakeProvider([{ status: 200, raw: "nope" }]);
    const g2 = build(externalEnv(malformed.url, { GATEWAY_MAX_ATTEMPTS: "1" }));
    await g2.invoke(request());
    const u = await g2.budgetStore!.usage(1);
    expect(u.requests).toBe(1);
    expect(u.estimatedCommits).toBe(1);
  });
});

describe("circuit breaker", () => {
  it("CLOSED -> OPEN after the threshold; OPEN rejects without calling the provider; HALF_OPEN success closes; HALF_OPEN failure reopens", async () => {
    const local = await fakeProvider([], { status: 503 });
    let clock = 1_000_000;
    const gateway = build({ ...localEnv(local.url), GATEWAY_MAX_ATTEMPTS: "1", GATEWAY_BREAKER_THRESHOLD: "2", GATEWAY_BREAKER_COOLDOWN_MS: "30000" }, { now: () => clock });
    expect((await gateway.status()).find(s => s.providerId === LOCAL_PROVIDER_ID)).toMatchObject({ state: "configured_unverified", breaker: "CLOSED" });

    await gateway.invoke(request()); await gateway.invoke(request());
    expect(local.requests).toHaveLength(2);
    expect(await gateway.breaker.state(LOCAL_PROVIDER_ID)).toBe("OPEN");

    const rejected = await gateway.invoke(request());
    expect(rejected).toMatchObject({ status: "failed", reason: "all_candidates_skipped" });
    expect(rejected.attempts[0].outcome).toBe("skipped:circuit_open");
    expect(local.requests).toHaveLength(2); // not contacted while OPEN
    expect((await gateway.status()).find(s => s.providerId === LOCAL_PROVIDER_ID)?.state).toBe("unhealthy");

    clock += 30_001; // cooldown elapsed -> one probe
    local.sticky = { status: 503 };
    const failedProbe = await gateway.invoke(request());
    expect(failedProbe.status).toBe("failed");
    expect(local.requests).toHaveLength(3);
    expect(await gateway.breaker.state(LOCAL_PROVIDER_ID)).toBe("OPEN"); // reopened immediately

    clock += 30_001;
    local.sticky = OK("healthy again");
    const probe = await gateway.invoke(request());
    expect(probe).toMatchObject({ status: "returned", content: "healthy again" });
    expect(await gateway.breaker.state(LOCAL_PROVIDER_ID)).toBe("CLOSED");
    expect((await gateway.status()).find(s => s.providerId === LOCAL_PROVIDER_ID)?.state).toBe("reachable_compatible");
  });

  it("admits only ONE concurrent half-open probe", async () => {
    const local = await fakeProvider([], { status: 503 });
    let clock = 5_000;
    const gateway = build({ ...localEnv(local.url), GATEWAY_MAX_ATTEMPTS: "1", GATEWAY_BREAKER_THRESHOLD: "1", GATEWAY_BREAKER_COOLDOWN_MS: "1000" }, { now: () => clock });
    await gateway.invoke(request());
    clock += 1001;
    local.sticky = { ...OK("slow"), delayMs: 150 };
    const [a, b] = await Promise.all([gateway.invoke(request()), gateway.invoke(request())]);
    expect([a.status, b.status].sort()).toEqual(["failed", "returned"]);
    expect(local.requests.length).toBe(2); // 1 trip + 1 probe
  });

  it("auth/caller errors neither open nor hold the circuit", async () => {
    const local = await fakeProvider([], { status: 401 });
    const gateway = build({ ...localEnv(local.url), GATEWAY_MAX_ATTEMPTS: "1", GATEWAY_BREAKER_THRESHOLD: "2" });
    for (let i = 0; i < 6; i += 1) await gateway.invoke(request());
    expect(await gateway.breaker.state(LOCAL_PROVIDER_ID)).toBe("CLOSED");
    expect(local.requests).toHaveLength(6);
  });

  it("breaker state is provider-scoped: one provider's outage does not block the other", async () => {
    const local = await fakeProvider([], { status: 503 });
    const ext = await fakeProvider([], OK("ext ok"));
    const gateway = build({ ...localEnv(local.url), ...externalEnv(ext.url), GATEWAY_MAX_ATTEMPTS: "1", GATEWAY_BREAKER_THRESHOLD: "1" });
    await gateway.invoke(request());
    expect(await gateway.breaker.state(LOCAL_PROVIDER_ID)).toBe("OPEN");
    expect(await gateway.breaker.state(EXTERNAL_PROVIDER_ID)).toBe("CLOSED");
    const next = await gateway.invoke(request());
    expect(next.status === "returned" && next.providerId).toBe(EXTERNAL_PROVIDER_ID);
    expect(local.requests).toHaveLength(1);
  });
});

describe("runtime status honesty", () => {
  it("nothing configured -> disabled; invalid configuration is reported, not routed", async () => {
    const gateway = build({ LOCAL_LLM_API_URL: "ftp://nope", LLM_API_URL: "http://api.example.com/v1", LLM_MODEL: "m" });
    const statuses = await gateway.status();
    expect(statuses.find(s => s.providerId === LOCAL_PROVIDER_ID)?.state).toBe("invalid_configuration");
    expect(statuses.find(s => s.providerId === EXTERNAL_PROVIDER_ID)?.state).toBe("invalid_configuration"); // external over plain http (non-loopback)
    expect(await gateway.invoke(request())).toMatchObject({ status: "failed", reason: "no_eligible_provider" });
    const empty = await build({}).status();
    expect(empty.every(s => s.state === "disabled")).toBe(true);
  });

  it("configured but never exercised is configured_unverified, NOT reachable_compatible", async () => {
    const local = await fakeProvider([OK("x")]);
    const gateway = build(localEnv(local.url));
    expect((await gateway.status()).find(s => s.providerId === LOCAL_PROVIDER_ID)?.state).toBe("configured_unverified");
    expect(local.requests).toHaveLength(0);
  });

  it("reachable_compatible only after a successful compatibility probe; a bad endpoint probes to unhealthy", async () => {
    const good = await fakeProvider([OK("pong")]);
    const g1 = build(localEnv(good.url));
    expect(await g1.probe(LOCAL_PROVIDER_ID)).toBe("reachable_compatible");
    expect(good.requests[0].body.max_tokens).toBe(1);

    const incompatible = await fakeProvider([{ status: 200, body: { hello: "world" } }]);
    const g2 = build(localEnv(incompatible.url));
    expect(await g2.probe(LOCAL_PROVIDER_ID)).toBe("unhealthy");
  });

  it("refuses to probe a metered external provider (a probe would spend money)", async () => {
    const ext = await fakeProvider([OK("x")]);
    await expect(build(externalEnv(ext.url)).probe(EXTERNAL_PROVIDER_ID)).rejects.toThrow(/metered/);
    expect(ext.requests).toHaveLength(0);
  });

  it("the catalog still ships every profile as runtimeEnabled:false (catalog presence is never a qualification)", async () => {
    const { MODEL_CATALOG } = await import("../model-fabric/catalog");
    expect(MODEL_CATALOG.every(model => model.runtimeEnabled === false)).toBe(true);
  });
});

describe("confidentiality and containment", () => {
  it("logs and outcomes never contain prompts, evidence, API keys or provider error bodies", async () => {
    const local = await fakeProvider([{ status: 500, body: { error: "echo SECRET-PROMPT-MARKER sk-SECRET-KEY-MARKER" } }]);
    const ext = await fakeProvider([OK("fine")]);
    const gateway = build({ ...localEnv(local.url), ...externalEnv(ext.url), GATEWAY_MAX_ATTEMPTS: "1" });
    const result = await gateway.invoke(request());
    const dump = JSON.stringify({ logs, result: { ...result, content: undefined } });
    expect(dump).not.toContain("SECRET-PROMPT-MARKER");
    expect(dump).not.toContain("sk-SECRET-KEY-MARKER");
    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0]).toMatchObject({ event: "gateway.invoke", requestId: "req-1", workspaceId: 1 });
  });

  it("an internal fault is reported as a failed outcome, never thrown and never as a success", async () => {
    const local = await fakeProvider([OK("x")]);
    const gateway = build(localEnv(local.url), { models: { map: () => { throw new Error("catalog fault"); } } as never });
    expect(await gateway.invoke(request())).toMatchObject({ status: "failed", reason: "internal_error" });
  });

  it("a failing shared breaker store never blocks the self-hosted provider (fail open) but always blocks external (fail closed)", async () => {
    const broken = { get: async () => { throw new Error("store down"); }, set: async () => { throw new Error("store down"); } };
    const local = await fakeProvider([OK("local ok")]);
    expect(await build(localEnv(local.url), { breakerStore: broken }).invoke(request())).toMatchObject({ status: "returned", providerId: LOCAL_PROVIDER_ID });
    const ext = await fakeProvider([], OK("must not be called"));
    const denied = await build(externalEnv(ext.url), { breakerStore: broken }).invoke(request());
    expect(denied.status).toBe("failed");
    expect(ext.requests).toHaveLength(0);
  });

  it("rejects credentials embedded in provider URLs and plain-http external providers", () => {
    expect(loadGatewayConfig({ LOCAL_LLM_API_URL: "http://user:pw@127.0.0.1:1", LOCAL_LLM_MODEL: "m" }).invalid[0]?.reason).toMatch(/credentials/);
    expect(loadGatewayConfig({ LLM_API_URL: "http://api.example.com", LLM_MODEL: "m" }).invalid[0]?.reason).toMatch(/https/);
    expect(loadGatewayConfig({ LLM_API_URL: "https://api.example.com", LLM_MODEL: "m" }).invalid).toEqual([]);
    expect(loadGatewayConfig({ LOCAL_LLM_API_URL: "http://127.0.0.1:1" }).invalid[0]?.reason).toMatch(/LOCAL_LLM_MODEL/);
  });

  it("every setting defaults to disabled/deny", () => {
    const config = loadGatewayConfig({});
    expect(config.bindings).toEqual([]);
    expect(config.policy).toEqual({ allowExternal: false, allowMetered: false });
    expect(config.budget.store).toBe("none");
  });
});
