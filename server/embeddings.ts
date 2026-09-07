import { ENV } from "./_core/env";

export type EmbeddingStatus = "available" | "unavailable";
export type EmbeddingVector = number[];

export interface EmbeddingAdapter {
  readonly provider: string;
  readonly model: string;
  embed(input: string): Promise<EmbeddingVector>;
}

function configuredAdapter(): EmbeddingAdapter | null {
  if (!ENV.embeddingApiUrl) return null;
  return {
    provider: ENV.embeddingProvider || "openai-compatible",
    model: ENV.embeddingModel || "configured",
    async embed(input) {
      const response = await fetch(ENV.embeddingApiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(ENV.embeddingApiKey ? { Authorization: `Bearer ${ENV.embeddingApiKey}` } : {}) },
        body: JSON.stringify({ model: ENV.embeddingModel || undefined, input }),
        signal: AbortSignal.timeout(ENV.embeddingTimeoutMs),
      });
      if (!response.ok) throw new Error(`Embedding provider returned ${response.status}`);
      const body = (await response.json()) as { data?: Array<{ embedding?: number[] }> };
      const vector = body.data?.[0]?.embedding;
      if (!Array.isArray(vector) || vector.length === 0 || vector.some(value => !Number.isFinite(value))) throw new Error("Embedding provider returned an invalid vector");
      return vector;
    },
  };
}

export function getEmbeddingAdapter(): EmbeddingAdapter | null { return configuredAdapter(); }
export function embeddingStatus(): { status: EmbeddingStatus; provider?: string; model?: string } {
  const adapter = configuredAdapter();
  return adapter ? { status: "available", provider: adapter.provider, model: adapter.model } : { status: "unavailable" };
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
export async function tryEmbed(input: string): Promise<{ vector: number[]; adapter: EmbeddingAdapter } | null> {
  const adapter = getEmbeddingAdapter();
  if (!adapter) return null;
  try { return { vector: await adapter.embed(input), adapter }; } catch (error) { console.warn("[Embeddings] unavailable:", error); return null; }
}
