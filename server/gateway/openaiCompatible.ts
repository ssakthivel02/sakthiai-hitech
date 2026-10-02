import { isRetryableHttpStatus } from "../_core/llm";
import {
  ERROR_TRAITS,
  ProviderCallError,
  type AdapterCall,
  type AdapterSuccess,
  type ProviderAdapter,
  type ProviderErrorClass,
} from "./types";

export type OpenAiCompatibleOptions = {
  providerId: string;
  /** e.g. https://api.example.com, http://localhost:11434/v1 (a trailing /v1 is honoured, not doubled). */
  baseUrl: string;
  apiKey?: string;
  /** Per-HTTP-attempt timeout. */
  timeoutMs?: number;
  /** Bounded HTTP attempts (first try included). */
  maxAttempts?: number;
  /** Hard ceiling across all attempts and backoff sleeps. */
  totalDeadlineMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
};

export const ADAPTER_DEFAULTS = {
  timeoutMs: 30_000,
  maxAttempts: 3,
  totalDeadlineMs: 60_000,
  backoffBaseMs: 250,
  backoffMaxMs: 5_000,
} as const;

export function chatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  return /\/v1$/.test(trimmed) ? `${trimmed}/chat/completions` : `${trimmed}/v1/chat/completions`;
}

function classifyStatus(status: number): ProviderErrorClass {
  if (status === 401 || status === 403) return "auth_failed";
  if (status === 408) return "timeout";
  if (status === 429) return "rate_limited";
  if (status >= 500 && status <= 599) return "server_error";
  if (status >= 400 && status <= 499) return "bad_request";
  return "unexpected_status";
}

function parseRetryAfterMs(value: string | null, now: number): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

const finiteNonNegative = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

/**
 * Parses an OpenAI-compatible chat completion into the provider-neutral shape. Throws
 * ProviderCallError("malformed_response" | "empty_response"); never returns vendor objects.
 */
export function normalizeCompletion(payload: unknown): Omit<AdapterSuccess, "attempts"> {
  if (!payload || typeof payload !== "object") throw new ProviderCallError("malformed_response");
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) throw new ProviderCallError("malformed_response");
  const first = choices[0] as { message?: { content?: unknown }; finish_reason?: unknown } | null;
  if (!first || typeof first !== "object" || !first.message || typeof first.message !== "object") throw new ProviderCallError("malformed_response");
  // Only plain string content is accepted: structured/array content is treated as malformed rather than guessed at.
  const content = first.message.content;
  if (typeof content !== "string") throw new ProviderCallError("malformed_response");
  if (!content.trim()) throw new ProviderCallError("empty_response");

  const usageRaw = (payload as { usage?: unknown }).usage;
  let usage: AdapterSuccess["usage"] = null;
  if (usageRaw && typeof usageRaw === "object") {
    const u = usageRaw as Record<string, unknown>;
    const promptTokens = finiteNonNegative(u.prompt_tokens);
    const completionTokens = finiteNonNegative(u.completion_tokens);
    const totalTokens = finiteNonNegative(u.total_tokens) ?? (promptTokens !== undefined && completionTokens !== undefined ? promptTokens + completionTokens : undefined);
    if (promptTokens !== undefined || completionTokens !== undefined || totalTokens !== undefined) usage = { promptTokens, completionTokens, totalTokens };
  }
  return { content, finishReason: typeof first.finish_reason === "string" ? first.finish_reason : null, usage };
}

export function createOpenAiCompatibleAdapter(options: OpenAiCompatibleOptions): ProviderAdapter {
  const timeoutMs = options.timeoutMs ?? ADAPTER_DEFAULTS.timeoutMs;
  const maxAttempts = Math.max(1, Math.min(options.maxAttempts ?? ADAPTER_DEFAULTS.maxAttempts, 6));
  const totalDeadlineMs = options.totalDeadlineMs ?? ADAPTER_DEFAULTS.totalDeadlineMs;
  const backoffBaseMs = options.backoffBaseMs ?? ADAPTER_DEFAULTS.backoffBaseMs;
  const backoffMaxMs = options.backoffMaxMs ?? ADAPTER_DEFAULTS.backoffMaxMs;
  const doFetch = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  const url = chatCompletionsUrl(options.baseUrl);

  async function attemptOnce(call: AdapterCall, attemptTimeoutMs: number): Promise<Omit<AdapterSuccess, "attempts">> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), attemptTimeoutMs);
    try {
      let response: Response;
      try {
        response = await doFetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}) },
          body: JSON.stringify({
            model: call.model,
            messages: call.messages,
            ...(call.maxOutputTokens ? { max_tokens: call.maxOutputTokens } : {}),
          }),
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted || (error as { name?: string })?.name === "AbortError") throw new ProviderCallError("timeout");
        throw new ProviderCallError("network");
      }

      if (!response.ok) {
        const status = response.status;
        const retryAfter = parseRetryAfterMs(response.headers.get("retry-after"), now());
        try { await response.body?.cancel(); } catch { /* ignore */ }
        const error = new ProviderCallError(classifyStatus(status), status);
        (error as ProviderCallError & { retryAfterMs?: number }).retryAfterMs = retryAfter;
        throw error;
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        if (controller.signal.aborted) throw new ProviderCallError("timeout");
        throw new ProviderCallError("malformed_response");
      }
      return normalizeCompletion(payload);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    providerId: options.providerId,
    async complete(call: AdapterCall): Promise<AdapterSuccess> {
      const startedAt = now();
      let last: ProviderCallError | undefined;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const remaining = totalDeadlineMs - (now() - startedAt);
        if (remaining <= 0) break;
        try {
          const result = await attemptOnce(call, Math.min(timeoutMs, remaining));
          return { ...result, attempts: attempt };
        } catch (error) {
          const failure = error instanceof ProviderCallError ? error : new ProviderCallError("network");
          last = new ProviderCallError(failure.errorClass, failure.httpStatus, attempt);
          const traits = ERROR_TRAITS[failure.errorClass];
          // 408 and the retryable statuses are retried; everything else (4xx, auth, malformed) fails fast.
          const statusRetryable = failure.httpStatus === undefined || isRetryableHttpStatus(failure.httpStatus);
          if (!traits.retryable || !statusRetryable || attempt >= maxAttempts) throw last;

          const retryAfter = (failure as ProviderCallError & { retryAfterMs?: number }).retryAfterMs;
          const cap = Math.min(backoffBaseMs * 2 ** (attempt - 1), backoffMaxMs);
          const jittered = cap / 2 + random() * (cap / 2);
          const delay = Math.max(jittered, retryAfter ?? 0);
          const left = totalDeadlineMs - (now() - startedAt);
          if (delay >= left) throw last; // would blow the deadline: give up now rather than sleep past it
          await sleep(delay);
        }
      }
      throw last ?? new ProviderCallError("timeout", undefined, 1);
    },
  };
}
