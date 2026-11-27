import type { BillingMode, ProviderKind } from "../model-fabric/types";
import { EXTERNAL_PROVIDER_ID, LOCAL_PROVIDER_ID } from "./config";
import type { GatewayOutcome, UsageSource } from "./types";

/**
 * Safe, credential-free description of ONE gateway model call, for traces and reports.
 * It is built only from fields the gateway itself returns about the provider that answered. It never contains the endpoint URL, API key,
 * headers, prompt or reply text. Anything not known is absent; consumers must treat absence as UNVERIFIED, never guess.
 */
export type ModelCallMeta = {
  providerId: string;
  modelId: string;
  profileId: string;
  providerKind: ProviderKind;
  billingMode: BillingMode;
  /** Which operator configuration family produced this binding (derived from the provider id; the values themselves are never exposed). */
  configSource: "env:LOCAL_LLM_*" | "env:LLM_*" | "unknown";
  /** "local" = self-hosted compute; "hosted" = a third-party API. Derived from the provider kind, never from a URL. */
  runtimeClass: "local" | "hosted";
  /** Endpoint profile label (e.g. gemini-openai); never a URL. */
  endpointProfile?: string;
  /** ISO-8601 time the gateway call was issued (set by the caller; absent if unknown). */
  invokedAt?: string;
  /** The gateway request id (opaque). Correlates this trace entry with gateway/budget logs. */
  correlationId?: string;
  /** What backs this record: the gateway's own configuration + response. The provider did not attest it, and model output was not inspected to produce it. */
  verification: "gateway_reported";
  /** True when a candidate was tried or skipped before the one that answered. */
  fallbackOccurred: boolean;
  usage: { source: UsageSource; promptTokens?: number; completionTokens?: number; totalTokens?: number; cost?: { amount: number; unit: string; estimated: boolean } };
  latencyMs: number;
  attempts: Array<{ providerId: string; outcome: string; httpAttempts?: number; latencyMs?: number }>;
};

const safeText = (s: unknown, max = 96): string => String(s ?? "").replace(/[^A-Za-z0-9 _.:/@+\-]/g, "?").slice(0, max);
const count = (n: unknown): number | undefined => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.round(n) : undefined);

/** Null when the outcome does not carry a usable provider/model identity (a partial gateway port): the caller must then treat it as UNVERIFIED. */
export function modelCallMeta(o: Extract<GatewayOutcome, { status: "returned" }>, ctx: { requestId?: string; invokedAt?: number } = {}): ModelCallMeta | null {
  if (typeof o.providerId !== "string" || !o.providerId || typeof o.modelId !== "string" || !o.modelId) return null;
  const u = o.usage ?? { source: "none" as const };
  return {
    providerId: safeText(o.providerId), modelId: safeText(o.modelId), profileId: safeText(o.profileId), providerKind: o.kind, billingMode: o.billingMode,
    configSource: o.providerId === LOCAL_PROVIDER_ID ? "env:LOCAL_LLM_*" : o.providerId === EXTERNAL_PROVIDER_ID ? "env:LLM_*" : "unknown",
    runtimeClass: o.kind === "self_hosted" ? "local" : "hosted",
    ...(typeof o.endpointProfile === "string" && o.endpointProfile ? { endpointProfile: safeText(o.endpointProfile, 40) } : {}),
    ...(typeof ctx.invokedAt === "number" && Number.isFinite(ctx.invokedAt) ? { invokedAt: new Date(ctx.invokedAt).toISOString() } : {}),
    ...(ctx.requestId ? { correlationId: safeText(ctx.requestId, 96) } : {}),
    verification: "gateway_reported",
    fallbackOccurred: (o.attempts ?? []).some((a) => a.outcome !== "ok"),
    usage: { source: u.source, ...(count(u.promptTokens) !== undefined ? { promptTokens: count(u.promptTokens) } : {}), ...(count(u.completionTokens) !== undefined ? { completionTokens: count(u.completionTokens) } : {}), ...(count(u.totalTokens) !== undefined ? { totalTokens: count(u.totalTokens) } : {}), ...(u.cost && Number.isFinite(u.cost.amount) && u.cost.amount >= 0 ? { cost: { amount: u.cost.amount, unit: safeText(u.cost.unit, 8), estimated: u.cost.estimated !== false } } : {}) },
    latencyMs: count(o.latencyMs) ?? 0,
    attempts: (o.attempts ?? []).slice(0, 6).map((a) => ({ providerId: safeText(a.providerId), outcome: safeText(a.outcome, 40), ...(count(a.httpAttempts) !== undefined ? { httpAttempts: count(a.httpAttempts) } : {}), ...(count(a.latencyMs) !== undefined ? { latencyMs: count(a.latencyMs) } : {}) })),
  };
}
