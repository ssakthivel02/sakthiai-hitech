import { createEmbeddingGateway, loadEmbeddingConfig, type EmbeddingGateway } from "./embedding/gateway";

export type EmbeddingStatus = "available" | "unavailable";
export type EmbeddingVector = number[];

export interface EmbeddingAdapter {
  readonly provider: string;
  readonly model: string;
  embed(input: string): Promise<EmbeddingVector>;
}

const EMBEDDING_ENV_KEYS = [
  "LOCAL_EMBEDDING_API_URL", "LOCAL_EMBEDDING_MODEL", "LOCAL_EMBEDDING_API_KEY", "LOCAL_EMBEDDING_DIMENSIONS",
  "EMBEDDING_API_URL", "EMBEDDING_API_KEY", "EMBEDDING_MODEL", "EMBEDDING_DIMENSIONS", "EMBEDDING_ALLOW_EXTERNAL",
  "EMBEDDING_TIMEOUT_MS", "EMBEDDING_MAX_ATTEMPTS", "EMBEDDING_TOTAL_DEADLINE_MS", "EMBEDDING_BACKOFF_BASE_MS", "EMBEDDING_BACKOFF_MAX_MS",
  "EMBEDDING_BREAKER_THRESHOLD", "EMBEDDING_BREAKER_COOLDOWN_MS",
] as const;

let cached: { signature: string; gateway: EmbeddingGateway } | null = null;
let override: EmbeddingGateway | null = null;

/** Lazily built from the environment (rebuilt only if the embedding env changes, so breaker state persists). */
export function getEmbeddingGateway(): EmbeddingGateway {
  if (override) return override;
  const signature = JSON.stringify(EMBEDDING_ENV_KEYS.map(key => process.env[key] ?? ""));
  if (!cached || cached.signature !== signature) cached = { signature, gateway: createEmbeddingGateway(loadEmbeddingConfig(process.env)) };
  return cached.gateway;
}
/** Test seam. */
export function setEmbeddingGatewayForTests(gateway: EmbeddingGateway | null) { override = gateway; cached = null; }

export function getEmbeddingAdapter(): EmbeddingAdapter | null {
  const first = getEmbeddingGateway().eligibleProviders()[0];
  if (!first) return null;
  return {
    provider: first.providerId,
    model: first.model,
    async embed(input) {
      const outcome = await getEmbeddingGateway().embed(input);
      if (outcome.status !== "ok") throw new Error(`embedding unavailable: ${outcome.reason}`);
      return outcome.vector;
    },
  };
}
export function embeddingStatus(): { status: EmbeddingStatus; provider?: string; model?: string; kind?: "self_hosted" | "external"; dimensions?: number | null; verified?: false } {
  return getEmbeddingGateway().status();
}
export function serializeEmbedding(vector: EmbeddingVector): string { return JSON.stringify(vector); }
export function parseEmbedding(value: string | null): EmbeddingVector | null {
  if (!value) return null;
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) && parsed.every(v => Number.isFinite(v)) ? parsed : null; } catch { return null; }
}
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, aNorm = 0, bNorm = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; aNorm += a[i] ** 2; bNorm += b[i] ** 2; }
  return aNorm && bNorm ? dot / (Math.sqrt(aNorm) * Math.sqrt(bNorm)) : 0;
}
/**
 * Embeds with the shared gateway. Any failure (timeout, auth, rate limit, malformed or wrong-dimension vector,
 * disabled) yields null so callers fall back to lexical retrieval; failures are logged without content or keys.
 */
export async function tryEmbed(input: string): Promise<{ vector: number[]; adapter: EmbeddingAdapter } | null> {
  const outcome = await getEmbeddingGateway().embed(input);
  if (outcome.status !== "ok") {
    if (outcome.reason !== "no_eligible_provider") console.warn(`[Embeddings] unavailable: ${outcome.reason}`);
    return null;
  }
  return { vector: outcome.vector, adapter: { provider: outcome.providerId, model: outcome.model, embed: async () => outcome.vector } };
}
