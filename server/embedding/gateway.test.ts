import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEmbeddingGateway, embeddingsUrl, loadEmbeddingConfig, validateVector, LOCAL_EMBEDDING_ID, EXTERNAL_EMBEDDING_ID, type EmbeddingConfig } from "./gateway";
import { rankChunkCandidates, normalizeRetrievalTerms } from "../retrieval";
import { setEmbeddingGatewayForTests, tryEmbed, embeddingStatus, serializeEmbedding } from "../embeddings";

/** Contract tests with an in-process transport: no network, no paid provider. */
type Behaviour = { vector?: unknown; body?: unknown; status?: number; hang?: true; headers?: Record<string, string> };
const LOCAL = "http://local.embed.invalid";
const EXTERNAL = "https://external.embed.invalid";

function harness(env: Record<string, string>, script: { local?: Behaviour[]; external?: Behaviour[] }) {
  const calls: Array<{ host: string; url: string; body: any; auth?: string }> = [];
  const queues: Record<string, Behaviour[]> = { "local.embed.invalid": [...(script.local ?? [])], "external.embed.invalid": [...(script.external ?? [])] };
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ host: url.hostname, url: String(input), body: JSON.parse(String(init?.body)), auth: (init?.headers as Record<string, string>)?.authorization });
    const queue = queues[url.hostname] ?? [];
    const behaviour = (queue.length > 1 ? queue.shift() : queue[0]) ?? { status: 500 };
    if (behaviour.hang) return new Promise<Response>((_res, rej) => init?.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))));
    if (behaviour.status) return new Response("{}", { status: behaviour.status, headers: behaviour.headers });
    const payload = behaviour.body !== undefined ? behaviour.body : { data: [{ embedding: behaviour.vector }] };
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const config = loadEmbeddingConfig({ EMBEDDING_BACKOFF_BASE_MS: "1", EMBEDDING_BACKOFF_MAX_MS: "1", ...env });
  const gateway = createEmbeddingGateway(config, { fetchImpl, sleep: async () => undefined, random: () => 0.5 });
  return { gateway, calls, config, hits: (host: string) => calls.filter(c => c.host === host).length };
}
const localEnv = { LOCAL_EMBEDDING_API_URL: LOCAL, LOCAL_EMBEDDING_MODEL: "bge-m3" };
const externalEnv = { EMBEDDING_API_URL: EXTERNAL, EMBEDDING_MODEL: "ext-embed", EMBEDDING_API_KEY: "k-not-secret" };
const V = [0.1, 0.2, 0.3];

describe("configuration", () => {
  it("builds the OpenAI-compatible URL for Ollama/vLLM/llama.cpp style bases and keeps legacy full URLs", () => {
    expect(embeddingsUrl("http://127.0.0.1:11434")).toBe("http://127.0.0.1:11434/v1/embeddings");
    expect(embeddingsUrl("http://127.0.0.1:11434/v1/")).toBe("http://127.0.0.1:11434/v1/embeddings");
    expect(embeddingsUrl("https://api.example.com/v1/embeddings")).toBe("https://api.example.com/v1/embeddings");
  });
  it("local is ordered before external; external needs explicit opt-in; invalid configs are reported, never used", () => {
    const cfg = loadEmbeddingConfig({ ...localEnv, ...externalEnv });
    expect(cfg.providers.map(p => p.providerId)).toEqual([LOCAL_EMBEDDING_ID, EXTERNAL_EMBEDDING_ID]);
    expect(cfg.allowExternal).toBe(false);
    expect(loadEmbeddingConfig({ LOCAL_EMBEDDING_API_URL: LOCAL }).invalid[0].reason).toMatch(/LOCAL_EMBEDDING_MODEL/);
    expect(loadEmbeddingConfig({ EMBEDDING_API_URL: "http://api.example.com" }).invalid[0].reason).toMatch(/https/);
    expect(loadEmbeddingConfig({ LOCAL_EMBEDDING_API_URL: "http://u:p@127.0.0.1:1", LOCAL_EMBEDDING_MODEL: "m" }).invalid[0].reason).toMatch(/credentials/);
    expect(loadEmbeddingConfig({ ...localEnv, LOCAL_EMBEDDING_DIMENSIONS: "0" }).invalid[0].reason).toMatch(/dimensions/);
    expect(loadEmbeddingConfig({ ...localEnv, LOCAL_EMBEDDING_DIMENSIONS: "abc" }).providers).toHaveLength(0);
  });
});

describe("vector validation", () => {
  it("rejects empty, non-array, non-numeric, non-finite, all-zero, oversized and wrong-dimension vectors", () => {
    for (const bad of [undefined, null, "x", {}, [], [1, "2"], [1, null], [1, Number.NaN], [1, Number.POSITIVE_INFINITY], [0, 0, 0], [[1, 2]], new Array(9000).fill(1)]) expect(() => validateVector(bad), JSON.stringify(bad)?.slice(0, 20)).toThrow();
    expect(validateVector([1, 2, 3], 3)).toEqual([1, 2, 3]);
    expect(() => validateVector([1, 2, 3], 4)).toThrow();
  });
});

describe("embedding gateway", () => {
  it("local success: posts to /v1/embeddings with the model, returns a validated vector, never touches external", async () => {
    const h = harness({ ...localEnv, ...externalEnv, EMBEDDING_ALLOW_EXTERNAL: "true" }, { local: [{ vector: V }], external: [{ vector: [9, 9, 9] }] });
    const out = await h.gateway.embed("முருகன் கோவில்");
    expect(out).toMatchObject({ status: "ok", providerId: LOCAL_EMBEDDING_ID, kind: "self_hosted", model: "bge-m3", dimensions: 3, vector: V });
    expect(h.calls[0]).toMatchObject({ url: `${LOCAL}/v1/embeddings`, body: { model: "bge-m3", input: "முருகன் கோவில்" } });
    expect(h.hits("external.embed.invalid")).toBe(0);
  });

  it("external success only with explicit opt-in; sends the bearer key; denied otherwise without any call", async () => {
    const allowed = harness({ ...externalEnv, EMBEDDING_ALLOW_EXTERNAL: "true" }, { external: [{ vector: V }] });
    expect(await allowed.gateway.embed("x")).toMatchObject({ status: "ok", providerId: EXTERNAL_EMBEDDING_ID, kind: "external" });
    expect(allowed.calls[0].auth).toBe("Bearer k-not-secret");
    const denied = harness({ ...externalEnv }, { external: [{ vector: V }] });
    expect(await denied.gateway.embed("x")).toMatchObject({ status: "failed", reason: "no_eligible_provider" });
    expect(denied.calls).toHaveLength(0);
    expect(denied.gateway.status()).toEqual({ status: "unavailable" });
  });

  it("falls back local -> external only when allowed and only for provider-health failures", async () => {
    const env = { ...localEnv, ...externalEnv, EMBEDDING_ALLOW_EXTERNAL: "true", EMBEDDING_MAX_ATTEMPTS: "1" };
    const fb = harness(env, { local: [{ status: 503 }], external: [{ vector: V }] });
    expect(await fb.gateway.embed("x")).toMatchObject({ status: "ok", providerId: EXTERNAL_EMBEDDING_ID });
    const noOptIn = harness({ ...localEnv, ...externalEnv, EMBEDDING_MAX_ATTEMPTS: "1" }, { local: [{ status: 503 }], external: [{ vector: V }] });
    expect(await noOptIn.gateway.embed("x")).toMatchObject({ status: "failed", reason: "server_error" });
    expect(noOptIn.hits("external.embed.invalid")).toBe(0);
  });

  it("401/403 are terminal: no retry, no fallback to a different data path", async () => {
    for (const status of [401, 403]) {
      const h = harness({ ...localEnv, ...externalEnv, EMBEDDING_ALLOW_EXTERNAL: "true" }, { local: [{ status }], external: [{ vector: V }] });
      expect(await h.gateway.embed("x")).toMatchObject({ status: "failed", reason: "auth_failed" });
      expect(h.hits("local.embed.invalid")).toBe(1);
      expect(h.hits("external.embed.invalid")).toBe(0);
    }
  });

  it("429 and 5xx are retried a bounded number of times, then reported", async () => {
    for (const [status, reason] of [[429, "rate_limited"], [500, "server_error"], [503, "server_error"]] as const) {
      const h = harness({ ...localEnv, EMBEDDING_MAX_ATTEMPTS: "3" }, { local: [{ status }] });
      expect(await h.gateway.embed("x")).toMatchObject({ status: "failed", reason });
      expect(h.hits("local.embed.invalid")).toBe(3);
    }
    const recovers = harness({ ...localEnv, EMBEDDING_MAX_ATTEMPTS: "3" }, { local: [{ status: 503 }, { status: 429 }, { vector: V }] });
    expect(await recovers.gateway.embed("x")).toMatchObject({ status: "ok", attempts: 3 });
  });

  it("4xx other than auth is a caller error: no retry", async () => {
    const h = harness({ ...localEnv, EMBEDDING_MAX_ATTEMPTS: "3" }, { local: [{ status: 400 }] });
    expect(await h.gateway.embed("x")).toMatchObject({ status: "failed", reason: "bad_request" });
    expect(h.hits("local.embed.invalid")).toBe(1);
  });

  it("a hung provider is aborted and classified as timeout", async () => {
    const h = harness({ ...localEnv, EMBEDDING_TIMEOUT_MS: "100", EMBEDDING_MAX_ATTEMPTS: "1" }, { local: [{ hang: true }] });
    expect(await h.gateway.embed("x")).toMatchObject({ status: "failed", reason: "timeout" });
  });

  it("malformed / empty / non-finite vectors are rejected and never retried or sent to another provider", async () => {
    const cases: Array<[string, Behaviour]> = [
      ["empty vector", { vector: [] }],
      ["string elements", { vector: ["a", "b"] }],
      ["null element", { vector: [1, null] }],
      ["all zero", { vector: [0, 0, 0] }],
      ["not an array", { vector: "oops" }],
    ];
    for (const [label, behaviour] of cases) {
      const h = harness({ ...localEnv, ...externalEnv, EMBEDDING_ALLOW_EXTERNAL: "true", EMBEDDING_MAX_ATTEMPTS: "3" }, { local: [behaviour], external: [{ vector: V }] });
      expect(await h.gateway.embed("x"), label).toMatchObject({ status: "failed", reason: "invalid_vector" });
      expect(h.calls, label).toHaveLength(1);
    }
    for (const body of [{}, { data: [] }, { data: "x" }, { data: [null] }, { data: [{}] }, [1, 2]]) {
      const h = harness({ ...localEnv, EMBEDDING_MAX_ATTEMPTS: "1" }, { local: [{ body }] });
      const out = await h.gateway.embed("x");
      expect(out.status, JSON.stringify(body)).toBe("failed");
    }
    const unparsable = harness({ ...localEnv, EMBEDDING_MAX_ATTEMPTS: "1" }, {});
    expect((await unparsable.gateway.embed("x")).status).toBe("failed");
  });

  it("enforces a configured dimension and learns one otherwise (model/dimension mismatch)", async () => {
    const fixed = harness({ ...localEnv, LOCAL_EMBEDDING_DIMENSIONS: "4" }, { local: [{ vector: V }] });
    expect(await fixed.gateway.embed("x")).toMatchObject({ status: "failed", reason: "dimension_mismatch" });
    const learned = harness({ ...localEnv }, { local: [{ vector: V }, { vector: [1, 2, 3, 4] }, { vector: [3, 2, 1] }] });
    expect((await learned.gateway.embed("a")).status).toBe("ok");
    expect(await learned.gateway.embed("b")).toMatchObject({ status: "failed", reason: "dimension_mismatch" }); // provider silently changed model
    expect((await learned.gateway.embed("c")).status).toBe("ok");
  });

  it("a bad vector as the FIRST response does not poison the learned dimension", async () => {
    const h = harness({ ...localEnv }, { local: [{ vector: [0, 0] }, { vector: V }] });
    expect((await h.gateway.embed("a")).status).toBe("failed");
    expect(await h.gateway.embed("b")).toMatchObject({ status: "ok", dimensions: 3 });
  });

  it("circuit opens after repeated provider failures so an outage does not stall every chunk", async () => {
    const h = harness({ ...localEnv, EMBEDDING_MAX_ATTEMPTS: "1", EMBEDDING_BREAKER_THRESHOLD: "2" }, { local: [{ status: 503 }] });
    await h.gateway.embed("1"); await h.gateway.embed("2");
    expect(h.hits("local.embed.invalid")).toBe(2);
    // self-hosted breaker state is in-memory and healthy, so the open circuit blocks further calls
    const third = await h.gateway.embed("3");
    expect(third).toMatchObject({ status: "failed", reason: "circuit_open" });
    expect(h.hits("local.embed.invalid")).toBe(2);
  });

  it("never throws and rejects empty input without a call", async () => {
    const h = harness(localEnv, { local: [{ vector: V }] });
    expect(await h.gateway.embed("   ")).toMatchObject({ status: "failed", reason: "empty_input" });
    expect(h.calls).toHaveLength(0);
  });
});

describe("degradation: retrieval stays correct when embeddings are off or broken", () => {
  beforeEach(() => setEmbeddingGatewayForTests(null));
  const row = (id: number, workspaceId: number, content: string, vector: number[] | null, model: string | null) => ({
    chunk: { id, workspaceId, content, embeddingJson: vector ? serializeEmbedding(vector) : null, embeddingModel: model },
    document: { filename: `d${id}.txt`, mimeType: "text/plain" },
  });
  const TAMIL = "முருகன் கோவில் பழநியில் உள்ளது";
  const MIXED = "முருகன் worship timings 2026";

  it("with every failure class the facade returns null and Tamil / mixed lexical retrieval still ranks correctly", async () => {
    const failures: Behaviour[] = [{ status: 503 }, { status: 401 }, { status: 429 }, { vector: [] }, { vector: ["x"] }, { hang: true }];
    for (const behaviour of failures) {
      const h = harness({ ...localEnv, EMBEDDING_MAX_ATTEMPTS: "1", EMBEDDING_TIMEOUT_MS: "100" }, { local: [behaviour] });
      setEmbeddingGatewayForTests(h.gateway);
      expect(await tryEmbed("முருகன் கோவில்")).toBeNull();
      const rows = [row(1, 1, TAMIL, null, null), row(2, 1, MIXED, null, null), row(3, 1, "unrelated english text", null, null)];
      expect(rankChunkCandidates(rows, "முருகன் கோவில் எங்கு", null).map(r => r.id)).toEqual([1, 2]);
      expect(rankChunkCandidates(rows, "worship timings", null).map(r => r.id)).toEqual([2]);
    }
  });

  it("disabled embeddings (no config) report unavailable and tryEmbed is null", async () => {
    setEmbeddingGatewayForTests(createEmbeddingGateway(loadEmbeddingConfig({})));
    expect(embeddingStatus()).toEqual({ status: "unavailable" });
    expect(await tryEmbed("x")).toBeNull();
  });

  it("embedding-assisted mode works for the same model; status exposes kind but never claims verification", async () => {
    const h = harness(localEnv, { local: [{ vector: [1, 0, 0] }] });
    setEmbeddingGatewayForTests(h.gateway);
    expect(embeddingStatus()).toMatchObject({ status: "available", kind: "self_hosted", model: "bge-m3", verified: false });
    const q = await tryEmbed("anything");
    expect(q?.adapter).toMatchObject({ provider: LOCAL_EMBEDDING_ID, model: "bge-m3" });
    const rows = [row(1, 1, "no lexical overlap here", [1, 0, 0], "bge-m3"), row(2, 1, "also nothing", [0, 1, 0], "bge-m3")];
    const ranked = rankChunkCandidates(rows, "zzzz", q!.vector, 8, "bge-m3");
    expect(ranked.map(r => [r.id, r.retrievalMethod])).toEqual([[1, "semantic"]]);
  });

  it("vectors from a different (or unrecorded) embedding model are never compared semantically", () => {
    const rows = [row(1, 1, "alpha beta", [1, 0, 0], "other-model"), row(2, 1, "alpha beta", [1, 0, 0], null), row(3, 1, "alpha beta", [1, 0, 0], "bge-m3")];
    const ranked = rankChunkCandidates(rows, "alpha", [1, 0, 0], 8, "bge-m3");
    expect(Object.fromEntries(ranked.map(r => [r.id, r.retrievalMethod]))).toEqual({ 1: "lexical", 2: "lexical", 3: "hybrid" });
    // different dimensions are also lexical-only
    expect(rankChunkCandidates([row(4, 1, "alpha", [1, 0], "bge-m3")], "alpha", [1, 0, 0], 8, "bge-m3")[0].retrievalMethod).toBe("lexical");
  });

  it("a query vector can never surface another tenant's chunk: ranking only sees rows the database already scoped", () => {
    const all = [row(1, 1, "tenant one budget", [1, 0, 0], "bge-m3"), row(2, 2, "tenant two confidential budget", [1, 0, 0], "bge-m3")];
    const scoped = all.filter(r => r.chunk.workspaceId === 1); // what db.searchChunks guarantees in SQL (verified on real MySQL in the integration suite)
    expect(rankChunkCandidates(scoped, "budget", [1, 0, 0], 8, "bge-m3").map(r => r.id)).toEqual([1]);
  });
});
