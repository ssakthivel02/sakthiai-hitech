import type { ModelCapability, ProviderKind, BillingMode, TaskIntent } from "../model-fabric/types";

/**
 * Provider-neutral contract between chat execution and any model provider.
 * Nothing vendor-specific (response objects, headers, error bodies) crosses this boundary.
 */

export type GatewayMessage = { role: "system" | "user" | "assistant"; content: string };

export type GatewayRequest = {
  requestId: string;
  /** Tenant identity. Budget and policy are always evaluated per workspace. */
  workspaceId: number;
  messages: GatewayMessage[];
  maxOutputTokens?: number;
  intents?: readonly TaskIntent[];
  requiredCapabilities?: readonly ModelCapability[];
  optionalCapabilities?: readonly ModelCapability[];
};

/** Why a provider call failed, in provider-neutral terms. */
export type ProviderErrorClass =
  | "timeout"
  | "network"
  | "rate_limited"
  | "server_error"
  | "malformed_response"
  | "empty_response"
  | "unexpected_status"
  | "auth_failed"
  | "bad_request";

export type ErrorTraits = {
  /** The adapter may retry the same provider (bounded). */
  retryable: boolean;
  /** Counts toward the circuit breaker (infrastructure/provider health). */
  breakerFailure: boolean;
  /** The gateway may try the next policy-eligible provider. */
  allowsFallback: boolean;
};

/**
 * Classification table. Authentication/authorization and caller errors are neither
 * retried nor treated as an outage, and never fall through to another provider: they
 * are configuration/request faults that must surface, not be masked.
 */
export const ERROR_TRAITS: Readonly<Record<ProviderErrorClass, ErrorTraits>> = {
  timeout: { retryable: true, breakerFailure: true, allowsFallback: true },
  network: { retryable: true, breakerFailure: true, allowsFallback: true },
  rate_limited: { retryable: true, breakerFailure: true, allowsFallback: true },
  server_error: { retryable: true, breakerFailure: true, allowsFallback: true },
  malformed_response: { retryable: false, breakerFailure: true, allowsFallback: true },
  empty_response: { retryable: false, breakerFailure: true, allowsFallback: true },
  unexpected_status: { retryable: false, breakerFailure: true, allowsFallback: true },
  auth_failed: { retryable: false, breakerFailure: false, allowsFallback: false },
  bad_request: { retryable: false, breakerFailure: false, allowsFallback: false },
};

/** Thrown by adapters only. Carries no response body, headers, prompt or credential. */
export class ProviderCallError extends Error {
  constructor(
    readonly errorClass: ProviderErrorClass,
    readonly httpStatus?: number,
    readonly attempts = 1,
  ) {
    super(`provider call failed: ${errorClass}${httpStatus ? ` (${httpStatus})` : ""}`);
    this.name = "ProviderCallError";
  }
}

export type UsageSource = "provider_reported" | "estimated" | "none";

export type GatewayUsage = {
  source: UsageSource;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** Present only when a configured rate exists AND token counts are available. Never a hard-coded price. */
  cost?: { amount: number; unit: string; basis: "configured_rate"; estimated: boolean };
};

export type AdapterCall = {
  messages: GatewayMessage[];
  maxOutputTokens?: number;
  model: string;
};

export type AdapterSuccess = {
  content: string;
  finishReason: string | null;
  usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number } | null;
  /** HTTP attempts made inside the adapter (>= 1). */
  attempts: number;
};

export interface ProviderAdapter {
  readonly providerId: string;
  complete(call: AdapterCall): Promise<AdapterSuccess>;
}

export type ProviderBinding = {
  /** Catalog profile (server/model-fabric) this runtime binding implements. */
  profileId: string;
  providerId: string;
  kind: ProviderKind;
  billingMode: BillingMode;
  baseUrl: string;
  model: string;
  apiKey?: string;
  timeoutMs: number;
};

export type RuntimeState =
  | "disabled"
  | "invalid_configuration"
  | "configured_unverified"
  | "reachable_compatible"
  | "unhealthy";

export type ProviderRuntimeStatus = {
  providerId: string;
  profileId: string;
  kind: ProviderKind;
  billingMode: BillingMode;
  state: RuntimeState;
  breaker: "CLOSED" | "OPEN" | "HALF_OPEN";
  lastSuccessAt?: number;
  lastFailureClass?: ProviderErrorClass;
};

export type AttemptRecord = {
  providerId: string;
  /** "ok" | an error class | a skip reason. */
  outcome: string;
  httpAttempts?: number;
  latencyMs?: number;
};

export type GatewayFailureReason =
  | "no_eligible_provider"
  | "all_candidates_skipped"
  | "budget_denied"
  | "internal_error"
  | "policy_denied"
  | ProviderErrorClass;

export type GatewayOutcome =
  | {
      status: "returned";
      content: string;
      providerId: string;
      modelId: string;
      profileId: string;
      kind: ProviderKind;
      billingMode: BillingMode;
      usage: GatewayUsage;
      attempts: AttemptRecord[];
      latencyMs: number;
    }
  | {
      status: "failed";
      reason: GatewayFailureReason;
      attempts: AttemptRecord[];
      latencyMs: number;
    };
