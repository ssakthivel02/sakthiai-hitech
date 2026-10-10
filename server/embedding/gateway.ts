import { CircuitBreaker } from "../gateway/circuitBreaker";
import { classifyStatus, isRetryableHttpStatus, parseRetryAfterMs } from "../gateway/openaiCompatible";
import { ERROR_TRAITS, ProviderCallError, type ProviderErrorClass } from "../gateway/types";

/**
 * Provider-neutral embedding gateway. Speaks the OpenAI-compatible `/v1/embeddings` protocol, which
 * Ollama, vLLM and llama.cpp (`--embedding`) all expose, so a self-hosted model needs no commercial API.
 *
 * Policy: local/self-hosted first. An external provider is used ONLY with EMBEDDING_ALLOW_EXTERNAL=true
 * (chunk text would leave the platform). Every failure degrades to "no vector" (lexical retrieval keeps
 * working); nothing here can widen what a query is allowed to see.
 */
export type EnvLike = Record<string, string | undefined>;
export type EmbeddingKind = "self_hosted" | "external";

export type EmbeddingProviderConfig = {
  providerId: string;
  kind: EmbeddingKind;
  baseUrl: string;
  model: string;
  apiKey?: string;
  /** Required vector length when configured; otherwise learned from the first valid vector. */
  dimensions?: number;
  timeoutMs: number;
};

export type EmbeddingConfig = {
  providers: EmbeddingProviderConfig[]; // local first
  invalid: Array<{ providerId: string; reason: string }>;
  allowExternal: boolean;
  maxAttempts: number;
  totalDeadlineMs: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  breaker: { failureThreshold: number; cooldownMs: number };
};

export const MAX_EMBEDDING_DIMENSIONS = 8192;
export const LOCAL_EMBEDDING_ID = "local-openai-compatible-embeddings";
export const EXTERNAL_EMBEDDING_ID = "external-embeddings";

const int = (value: string | undefined, fallback: number, min: number, max: number) => {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
};
const isLoopback = (host: string) => host === "localhost" || host === "::1" || host === "[::1]" || /^127\./.test(host);

function validateUrl(raw: string, external: boolean): string | null {
  let url: URL;
  try { url = new URL(raw); } catch { return "not a valid URL"; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "must be http(s)";
  if (url.username || url.password) return "must not embed credentials";
  if (external && url.protocol !== "https:" && !isLoopback(url.hostname)) return "external providers require https";
  return null;
}

/** `.../v1` -> `.../v1/embeddings`; a URL already ending in `/embeddings` is used as given (back-compat). */
export function embeddingsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (/\/embeddings$/.test(trimmed)) return trimmed;
  return /\/v1$/.test(trimmed) ? `${trimmed}/embeddings` : `${trimmed}/v1/embeddings`;
}

export function loadEmbeddingConfig(env: EnvLike): EmbeddingConfig {
  const providers: EmbeddingProviderConfig[] = [];
  const invalid: EmbeddingConfig["invalid"] = [];
  const timeoutMs = int(env.EMBEDDING_TIMEOUT_MS, 8000, 100, 120_000);

  const dims = (value: string | undefined): number | undefined | "bad" => {
    if (value === undefined || value.trim() === "") return undefined;
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= 1 && parsed <= MAX_EMBEDDING_DIMENSIONS ? parsed : "bad";
  };

  const localUrl = env.LOCAL_EMBEDDING_API_URL?.trim();
  if (localUrl) {
    const dimensions = dims(env.LOCAL_EMBEDDING_DIMENSIONS ?? env.EMBEDDING_DIMENSIONS);
    const problem = validateUrl(localUrl, false) ?? (env.LOCAL_EMBEDDING_MODEL?.trim() ? null : "LOCAL_EMBEDDING_MODEL is required") ?? null;
    const reason = problem ?? (dimensions === "bad" ? "dimensions must be an integer between 1 and 8192" : null);
    if (reason) invalid.push({ providerId: LOCAL_EMBEDDING_ID, reason });
    else providers.push({ providerId: LOCAL_EMBEDDING_ID, kind: "self_hosted", baseUrl: localUrl, model: env.LOCAL_EMBEDDING_MODEL!.trim(), apiKey: env.LOCAL_EMBEDDING_API_KEY?.trim() || undefined, dimensions: dimensions === "bad" ? undefined : dimensions, timeoutMs });
  }

  const externalUrl = env.EMBEDDING_API_URL?.trim();
  if (externalUrl) {
    const dimensions = dims(env.EMBEDDING_DIMENSIONS);
    const reason = validateUrl(externalUrl, true) ?? (dimensions === "bad" ? "dimensions must be an integer between 1 and 8192" : null);
    if (reason) invalid.push({ providerId: EXTERNAL_EMBEDDING_ID, reason });
    else providers.push({ providerId: EXTERNAL_EMBEDDING_ID, kind: "external", baseUrl: externalUrl, model: env.EMBEDDING_MODEL?.trim() || "configured", apiKey: env.EMBEDDING_API_KEY?.trim() || undefined, dimensions: dimensions === "bad" ? undefined : dimensions, timeoutMs });
  }

  return {
    providers,
    invalid,
    allowExternal: env.EMBEDDING_ALLOW_EXTERNAL?.trim().toLowerCase() === "true",
    maxAttempts: int(env.EMBEDDING_MAX_ATTEMPTS, 2, 1, 5),
    totalDeadlineMs: int(env.EMBEDDING_TOTAL_DEADLINE_MS, 20_000, 100, 300_000),
    backoffBaseMs: int(env.EMBEDDING_BACKOFF_BASE_MS, 200, 1, 60_000),
    backoffMaxMs: int(env.EMBEDDING_BACKOFF_MAX_MS, 2000, 1, 120_000),
    breaker: { failureThreshold: int(env.EMBEDDING_BREAKER_THRESHOLD, 3, 1, 100), cooldownMs: int(env.EMBEDDING_BREAKER_COOLDOWN_MS, 30_000, 0, 3_600_000) },
  };
}

export type EmbeddingFailure = ProviderErrorClass | "dimension_mismatch" | "invalid_vector" | "no_eligible_provider" | "empty_input" | "circuit_open";
export type EmbeddingOutcome =
  | { status: "ok"; vector: number[]; providerId: string; kind: EmbeddingKind; model: string; dimensions: number; attempts: number }
  | { status: "failed"; reason: EmbeddingFailure; tried: Array<{ providerId: string; outcome: string }> };

export type EmbeddingDeps = {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
};

class VectorError extends Error {
  constructor(readonly reason: "invalid_vector" | "dimension_mismatch") {
    super(reason);
  }
}

/** Accepts only a non-empty, bounded array of finite, non-degenerate numbers. */
export function validateVector(raw: unknown, expectedDimensions?: number): number[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_EMBEDDING_DIMENSIONS) throw new VectorError("invalid_vector");
  let norm = 0;
  for (const value of raw) {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new VectorError("invalid_vector");
    norm += value * value;
  }
  if (!(norm > 0) || !Number.isFinite(norm)) throw new VectorError("invalid_vector"); // all-zero or overflowing
  if (expectedDimensions !== undefined && raw.length !== expectedDimensions) throw new VectorError("dimension_mismatch");
  return raw as number[];
}

export function createEmbeddingGateway(config: EmbeddingConfig, deps: EmbeddingDeps = {}) {
  const doFetch = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const random = deps.random ?? Math.random;
  const now = deps.now ?? Date.now;
  const breaker = new CircuitBreaker(undefined, config.breaker, now);
  const learned = new Map<string, number>(); // providerId -> first valid dimension

  const eligible = config.providers.filter(provider => provider.kind === "self_hosted" || config.allowExternal);

  async function callOnce(provider: EmbeddingProviderConfig, input: string, timeoutMs: number): Promise<number[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response: Response;
      try {
        response = await doFetch(embeddingsUrl(provider.baseUrl), {
          method: "POST",
          headers: { "content-type": "application/json", ...(provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {}) },
          body: JSON.stringify({ model: provider.model, input }),
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted || (error as { name?: string })?.name === "AbortError") throw new ProviderCallError("timeout");
        throw new ProviderCallError("network");
      }
      if (!response.ok) {
        const error = new ProviderCallError(classifyStatus(response.status), response.status);
        (error as ProviderCallError & { retryAfterMs?: number }).retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"), now());
        try { await response.body?.cancel(); } catch { /* ignore */ }
        throw error;
      }
      let payload: unknown;
      try { payload = await response.json(); } catch { throw new ProviderCallError(controller.signal.aborted ? "timeout" : "malformed_response"); }
      const data = (payload as { data?: unknown })?.data;
      const first = Array.isArray(data) ? (data[0] as { embedding?: unknown } | undefined) : undefined;
      if (!first || typeof first !== "object") throw new ProviderCallError("malformed_response");
      try {
        return validateVector(first.embedding, provider.dimensions ?? learned.get(provider.providerId));
      } catch (error) {
        if (error instanceof VectorError) throw error;
        throw new ProviderCallError("malformed_response");
      }
    } finally {
      clearTimeout(timer);
    }
  }

  async function withRetry(provider: EmbeddingProviderConfig, input: string): Promise<{ vector: number[]; attempts: number }> {
    const startedAt = now();
    let last: ProviderCallError | undefined;
    for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
      const remaining = config.totalDeadlineMs - (now() - startedAt);
      if (remaining <= 0) break;
      try {
        return { vector: await callOnce(provider, input, Math.min(provider.timeoutMs, remaining)), attempts: attempt };
      } catch (error) {
        if (error instanceof VectorError) throw error; // a bad vector is not transient: never retried
        const failure = error instanceof ProviderCallError ? error : new ProviderCallError("network");
        last = new ProviderCallError(failure.errorClass, failure.httpStatus, attempt);
        const statusRetryable = failure.httpStatus === undefined || isRetryableHttpStatus(failure.httpStatus);
        if (!ERROR_TRAITS[failure.errorClass].retryable || !statusRetryable || attempt >= config.maxAttempts) throw last;
        const cap = Math.min(config.backoffBaseMs * 2 ** (attempt - 1), config.backoffMaxMs);
        const delay = Math.max(cap / 2 + random() * (cap / 2), (failure as ProviderCallError & { retryAfterMs?: number }).retryAfterMs ?? 0);
        if (delay >= config.totalDeadlineMs - (now() - startedAt)) throw last;
        await sleep(delay);
      }
    }
    throw last ?? new ProviderCallError("timeout", undefined, 1);
  }

  async function embed(input: string): Promise<EmbeddingOutcome> {
    const tried: Array<{ providerId: string; outcome: string }> = [];
    if (typeof input !== "string" || input.trim() === "") return { status: "failed", reason: "empty_input", tried };
    if (!eligible.length) return { status: "failed", reason: "no_eligible_provider", tried };
    let lastReason: EmbeddingFailure = "no_eligible_provider";
    try {
      for (const provider of eligible) {
        const admission = await breaker.admit(provider.providerId, { failOpen: provider.kind === "self_hosted" });
        if (!admission.allowed) { tried.push({ providerId: provider.providerId, outcome: "skipped:circuit_open" }); lastReason = "circuit_open"; continue; }
        try {
          const result = await withRetry(provider, input);
          // Learn the dimension only from a vector that already passed every other check.
          if (provider.dimensions === undefined && !learned.has(provider.providerId)) learned.set(provider.providerId, result.vector.length);
          await breaker.recordSuccess(provider.providerId);
          tried.push({ providerId: provider.providerId, outcome: "ok" });
          return { status: "ok", vector: result.vector, providerId: provider.providerId, kind: provider.kind, model: provider.model, dimensions: result.vector.length, attempts: result.attempts };
        } catch (error) {
          if (error instanceof VectorError) {
            // Wrong/garbage vectors say the provider is misconfigured, not unhealthy: do not open the circuit, do not fall back to a different data path.
            await breaker.recordNeutral(provider.providerId);
            tried.push({ providerId: provider.providerId, outcome: error.reason });
            return { status: "failed", reason: error.reason, tried };
          }
          const failure = error instanceof ProviderCallError ? error : new ProviderCallError("network");
          const traits = ERROR_TRAITS[failure.errorClass];
          if (traits.breakerFailure) await breaker.recordFailure(provider.providerId);
          else await breaker.recordNeutral(provider.providerId);
          tried.push({ providerId: provider.providerId, outcome: failure.errorClass });
          lastReason = failure.errorClass;
          if (!traits.allowsFallback) return { status: "failed", reason: failure.errorClass, tried }; // auth/caller errors are terminal
        }
      }
    } catch {
      return { status: "failed", reason: "network", tried };
    }
    return { status: "failed", reason: lastReason, tried };
  }

  function status() {
    const first = eligible[0];
    return first
      ? { status: "available" as const, provider: first.providerId, model: first.model, kind: first.kind, dimensions: first.dimensions ?? null, verified: false as const }
      : { status: "unavailable" as const };
  }

  return { embed, status, eligibleProviders: () => eligible.map(p => ({ providerId: p.providerId, kind: p.kind, model: p.model })), config };
}

export type EmbeddingGateway = ReturnType<typeof createEmbeddingGateway>;
