import type { CreatorFailureClass } from "../types";

export type CallControl = {
  /** Caller-owned cancellation. Aborting stops further provider calls; see each provider for what it cannot undo. */
  signal?: AbortSignal;
  onProgress?: (event: SpeechProgressEvent) => void;
};

export type SpeechProgressEvent = {
  stage: string;
  completed: number;
  total: number;
  /** Provider-reported percentage when the provider supplies one; otherwise undefined (never invented). */
  percent?: number;
};

export class SpeechProviderError extends Error {
  constructor(
    readonly code: string,
    readonly failureClass: CreatorFailureClass | "CANCELLED",
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(code);
    this.name = "SpeechProviderError";
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function classifyHttpStatus(status: number): { failureClass: CreatorFailureClass; retryable: boolean } {
  if (status === 401 || status === 403) return { failureClass: "AUTH", retryable: false };
  if (status === 402) return { failureClass: "QUOTA", retryable: false };
  if (status === 429) return { failureClass: "RATE_LIMIT", retryable: true };
  if (status === 408 || status === 504) return { failureClass: "TIMEOUT", retryable: true };
  if (status >= 500) return { failureClass: "PROVIDER_UNAVAILABLE", retryable: true };
  if (status === 451) return { failureClass: "CONTENT_POLICY", retryable: false };
  return { failureClass: "INVALID_REQUEST", retryable: false };
}

/** Combine the caller's cancellation with a per-call timeout. */
export function callSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export function toSpeechError(error: unknown, control: CallControl | undefined): SpeechProviderError {
  if (error instanceof SpeechProviderError) return error;
  if (control?.signal?.aborted) return new SpeechProviderError("SPEECH_CANCELLED", "CANCELLED", false);
  const name = (error as { name?: string })?.name;
  if (name === "TimeoutError" || name === "AbortError") return new SpeechProviderError("SPEECH_PROVIDER_TIMEOUT", "TIMEOUT", true);
  return new SpeechProviderError("SPEECH_PROVIDER_NETWORK", "NETWORK", true);
}
