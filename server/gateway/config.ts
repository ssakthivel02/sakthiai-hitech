import type { BillingMode } from "../model-fabric/types";
import type { WorkspaceBudgetPolicy } from "./budget";
import { isEndpointProfileId, validatePinnedOrigin, isPinnedProfile, type EndpointProfileId } from "./endpointProfiles";
import type { ProviderBinding } from "./types";
import { classifyHost, needsResolutionCheck, normalizeHost, parseAllowedHosts } from "./hostClass";

/**
 * Gateway configuration, read from the environment. Everything is DISABLED by default:
 *  - no local provider unless LOCAL_LLM_API_URL (+ LOCAL_LLM_MODEL) is set;
 *  - the existing LLM_API_URL provider is treated as EXTERNAL and is unusable until
 *    GATEWAY_ALLOW_EXTERNAL=true (and, when it is metered, GATEWAY_ALLOW_METERED=true plus a budget).
 */
export type EnvLike = Record<string, string | undefined>;

export type GatewayConfig = {
  bindings: ProviderBinding[];
  invalid: Array<{ providerId: string; reason: string }>;
  stateStore: "memory" | "mysql";
  policy: { allowExternal: boolean; allowMetered: boolean };
  budget: {
    store: "none" | "memory" | "mysql";
    defaults: WorkspaceBudgetPolicy;
    /** Cost per 1,000 tokens in `unit`. Absent = cost cannot be computed (and a cost ceiling fails closed). */
    rates?: { promptPer1k: number; completionPer1k: number; unit: string };
    defaultMaxOutputTokens: number;
  };
  breaker: { failureThreshold: number; cooldownMs: number };
  retry: { maxAttempts: number; totalDeadlineMs: number; backoffBaseMs: number; backoffMaxMs: number };
  maxCandidates: number;
};

export const LOCAL_PROVIDER_ID = "local-openai-compatible";
export const EXTERNAL_PROVIDER_ID = "external-openai-compatible";

const flag = (value: string | undefined) => value?.trim().toLowerCase() === "true";

function positiveInt(value: string | undefined, fallback: number, max: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= max ? parsed : fallback;
}

function optionalPositive(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function isLoopback(hostname: string) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/** Returns an error string, or null when the URL is acceptable for this provider class. */
export function validateProviderUrl(raw: string, external: boolean): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return "not a valid URL";
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "must be http(s)";
  if (parsed.username || parsed.password) return "must not embed credentials";
  if (external && parsed.protocol !== "https:" && !isLoopback(parsed.hostname)) return "external providers require https";
  return null;
}

/**
 * Registrable domains of hosted LLM APIs. The local slot is classed self_hosted / local_compute, which exempts it from GATEWAY_ALLOW_EXTERNAL,
 * GATEWAY_ALLOW_METERED and the workspace spend budget. A hosted provider configured there would therefore be served with no policy and no
 * budget, so these hosts are refused in the local slot unconditionally (they belong in the external binding, LLM_*).
 * This list is a floor, not a proof: the host classification below is what excludes unlisted vendors.
 */
const HOSTED_PROVIDER_DOMAINS: readonly string[] = [
  "sarvam.ai", "googleapis.com", "openai.com", "anthropic.com", "mistral.ai", "groq.com", "openrouter.ai", "together.xyz", "together.ai",
  "deepseek.com", "cohere.com", "cohere.ai", "x.ai", "perplexity.ai", "fireworks.ai", "moonshot.ai", "moonshot.cn", "openai.azure.com", "cognitiveservices.azure.com",
];

/**
 * Extra checks for the LOCAL slot only (validateProviderUrl has already run). Returns an error string or null. Fail closed.
 *  1. A known hosted-provider domain is refused, always.
 *  2. The destination is classified from the parsed URL host (see hostClass.ts; IPv4 forms, IPv6, IPv4-mapped IPv6 and trailing dots are normalised):
 *       loopback (localhost, 127/8, ::1)             accepted, http or https  (Ollama on this machine)
 *       *.invalid                                      accepted (can never resolve)
 *       private-network IP or internal name            accepted ONLY if the exact host is listed in LOCAL_LLM_ALLOWED_HOSTS
 *       anything public (any scheme, IP literal or name) refused. There is NO override: LOCAL_LLM_ALLOW_PUBLIC_HOST is ignored.
 *  A public or hosted model belongs in the external binding (LLM_*), where GATEWAY_ALLOW_EXTERNAL, GATEWAY_ALLOW_METERED and the budget apply.
 *  Reasons never contain the configured host so the owner-visible runtime status does not leak internal names.
 */
export function validateLocalSlotUrl(raw: string, env: EnvLike, allowlistVar: "LOCAL_LLM_ALLOWED_HOSTS" | "LOCAL_EMBEDDING_ALLOWED_HOSTS" = "LOCAL_LLM_ALLOWED_HOSTS"): string | null {
  let parsed: URL;
  try { parsed = new URL(raw); } catch { return "not a valid URL"; }
  const host = normalizeHost(parsed.hostname);
  if (HOSTED_PROVIDER_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))) {
    return "names a hosted provider; configure it as the external provider (LLM_*) so policy and budget apply, not as the local provider";
  }
  switch (classifyHost(host)) {
    case "loopback":
    case "unroutable":
      return null;
    case "private":
    case "internal":
      return parseAllowedHosts(env[allowlistVar]).has(host)
        ? null
        : `is a private-network host that is not approved; list this exact host in ${allowlistVar}, or use a loopback address`;
    default:
      return `is a public destination, which cannot hold local privileges (no external-provider policy, no spend budget); configure it as the external provider${allowlistVar === "LOCAL_LLM_ALLOWED_HOSTS" ? " (LLM_*)" : " (EMBEDDING_*)"}${env.LOCAL_LLM_ALLOW_PUBLIC_HOST?.trim() ? "; LOCAL_LLM_ALLOW_PUBLIC_HOST is no longer honoured" : ""}`;
  }
}

const BILLING_MODES: readonly BillingMode[] = ["local_compute", "metered_api", "subscription"];

export function loadGatewayConfig(env: EnvLike): GatewayConfig {
  const bindings: ProviderBinding[] = [];
  const invalid: GatewayConfig["invalid"] = [];
  const timeoutMs = positiveInt(env.GATEWAY_TIMEOUT_MS, 30_000, 300_000);

  const localUrl = env.LOCAL_LLM_API_URL?.trim();
  if (localUrl) {
    const problem = validateProviderUrl(localUrl, false) ?? validateLocalSlotUrl(localUrl, env) ?? (env.LOCAL_LLM_MODEL?.trim() ? null : "LOCAL_LLM_MODEL is required");
    if (problem) invalid.push({ providerId: LOCAL_PROVIDER_ID, reason: problem });
    else {
      const profileId = env.LOCAL_LLM_PROFILE?.trim() || "sakthi-local-general";
      bindings.push({
        profileId,
        providerId: LOCAL_PROVIDER_ID,
        kind: "self_hosted",
        billingMode: "local_compute",
        baseUrl: localUrl,
        model: env.LOCAL_LLM_MODEL!.trim(),
        apiKey: env.LOCAL_LLM_API_KEY?.trim() || undefined,
        timeoutMs,
        // A name (not an IP literal) must resolve only to loopback/private addresses at request time; redirects are never followed for the local slot.
        ...(needsResolutionCheck(new URL(localUrl).hostname) ? { resolveGuard: true } : {}),
      });
    }
  }

  const externalUrl = (env.LLM_API_URL ?? env.OPENAI_BASE_URL)?.trim();
  if (externalUrl) {
    const model = env.LLM_MODEL?.trim();
    const problem = validateProviderUrl(externalUrl, true) ?? (model ? null : "LLM_MODEL is required");
    const billing = (env.LLM_BILLING_MODE?.trim() || "metered_api") as BillingMode;
    // Unset = historical behaviour. A set-but-unknown value is refused (fail closed), never silently treated as the default.
    const rawProfile = env.LLM_ENDPOINT_PROFILE?.trim();
    const profile: EndpointProfileId | null = !rawProfile ? "openai-v1" : isEndpointProfileId(rawProfile) ? rawProfile : null;
    const pinned = profile && isPinnedProfile(profile) ? validatePinnedOrigin(profile as Exclude<EndpointProfileId, "openai-v1">, externalUrl) : null;
    if (profile === null) invalid.push({ providerId: EXTERNAL_PROVIDER_ID, reason: "LLM_ENDPOINT_PROFILE is not a recognised profile" });
    else if (pinned && !pinned.ok) invalid.push({ providerId: EXTERNAL_PROVIDER_ID, reason: pinned.reason });
    else if (problem) invalid.push({ providerId: EXTERNAL_PROVIDER_ID, reason: problem });
    else if (!BILLING_MODES.includes(billing) || billing === "local_compute") invalid.push({ providerId: EXTERNAL_PROVIDER_ID, reason: "LLM_BILLING_MODE must be metered_api or subscription" });
    else {
      bindings.push({
        profileId: "frontier-external-reference",
        providerId: EXTERNAL_PROVIDER_ID,
        kind: "external",
        billingMode: billing,
        baseUrl: externalUrl,
        model: model!,
        apiKey: (env.LLM_API_KEY ?? env.OPENAI_API_KEY)?.trim() || undefined,
        timeoutMs,
        endpointProfile: profile ?? "openai-v1",
      });
    }
  }

  const promptRate = optionalPositive(env.GATEWAY_COST_PER_1K_PROMPT_TOKENS);
  const completionRate = optionalPositive(env.GATEWAY_COST_PER_1K_COMPLETION_TOKENS);
  const unit = env.GATEWAY_COST_UNIT?.trim();
  const rates = promptRate !== undefined && completionRate !== undefined && unit ? { promptPer1k: promptRate, completionPer1k: completionRate, unit } : undefined;

  return {
    bindings,
    invalid,
    /** Where breaker/budget/policy state lives. "mysql" shares it across instances; "memory" is per-process. */
    stateStore: (env.GATEWAY_STATE_STORE?.trim().toLowerCase() === "mysql" ? "mysql" : "memory") as "mysql" | "memory",
    policy: { allowExternal: flag(env.GATEWAY_ALLOW_EXTERNAL), allowMetered: flag(env.GATEWAY_ALLOW_METERED) },
    budget: {
      store: (env.GATEWAY_STATE_STORE?.trim().toLowerCase() === "mysql" ? "mysql" : env.GATEWAY_BUDGET_STORE?.trim().toLowerCase() === "memory" ? "memory" : "none") as "mysql" | "memory" | "none",
      defaults: {
        externalEnabled: flag(env.GATEWAY_ALLOW_EXTERNAL),
        maxRequests: optionalPositive(env.GATEWAY_EXTERNAL_MAX_REQUESTS_PER_DAY),
        maxTokens: optionalPositive(env.GATEWAY_EXTERNAL_MAX_TOKENS_PER_DAY),
        maxCost: optionalPositive(env.GATEWAY_EXTERNAL_MAX_COST_PER_DAY),
      },
      rates,
      defaultMaxOutputTokens: positiveInt(env.GATEWAY_MAX_OUTPUT_TOKENS, 1024, 32_768),
    },
    breaker: { failureThreshold: positiveInt(env.GATEWAY_BREAKER_THRESHOLD, 5, 100), cooldownMs: positiveInt(env.GATEWAY_BREAKER_COOLDOWN_MS, 30_000, 3_600_000) },
    retry: {
      maxAttempts: positiveInt(env.GATEWAY_MAX_ATTEMPTS, 3, 6),
      totalDeadlineMs: positiveInt(env.GATEWAY_TOTAL_DEADLINE_MS, 60_000, 600_000),
      backoffBaseMs: positiveInt(env.GATEWAY_BACKOFF_BASE_MS, 250, 60_000),
      backoffMaxMs: positiveInt(env.GATEWAY_BACKOFF_MAX_MS, 5_000, 120_000),
    },
    maxCandidates: positiveInt(env.GATEWAY_MAX_CANDIDATES, 3, 10),
  };
}
