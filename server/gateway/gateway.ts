import { MODEL_CATALOG } from "../model-fabric/catalog";
import { routeModel } from "../model-fabric/router";
import type { ModelProfile, RoutingRequest } from "../model-fabric/types";
import { hasAnyBudgetLimit, InMemoryBudgetStore, type BudgetStore, type Reservation, type WorkspaceBudgetPolicy } from "./budget";
import { CircuitBreaker, type BreakerConfig, type BreakerStore } from "./circuitBreaker";
import type { GatewayConfig } from "./config";
import { createOpenAiCompatibleAdapter } from "./openaiCompatible";
import {
  ERROR_TRAITS,
  ProviderCallError,
  type AdapterSuccess,
  type AttemptRecord,
  type GatewayOutcome,
  type GatewayRequest,
  type GatewayUsage,
  type ProviderAdapter,
  type ProviderBinding,
  type ProviderErrorClass,
  type ProviderRuntimeStatus,
  type RuntimeState,
} from "./types";

export interface WorkspacePolicyResolver {
  resolve(workspaceId: number): Promise<WorkspaceBudgetPolicy>;
}

export type GatewayDependencies = {
  /** Test seam / alternative transports. Defaults to the OpenAI-compatible adapter. */
  adapterFactory?: (binding: ProviderBinding, config: GatewayConfig) => ProviderAdapter;
  breakerStore?: BreakerStore;
  budgetStore?: BudgetStore;
  policyResolver?: WorkspacePolicyResolver;
  models?: readonly ModelProfile[];
  now?: () => number;
  /** Structured, prompt-free and secret-free log sink. */
  log?: (entry: Record<string, unknown>) => void;
};

const SKIP_CIRCUIT_OPEN = "skipped:circuit_open";

/** Conservative worst-case token estimate. ESTIMATE only: never presented as provider usage. */
export function estimateTokens(messages: GatewayRequest["messages"], maxOutputTokens: number): number {
  const chars = messages.reduce((sum, message) => sum + message.content.length, 0);
  return Math.ceil(chars / 3) + maxOutputTokens;
}

function computeCost(rates: NonNullable<GatewayConfig["budget"]["rates"]>, prompt: number, completion: number) {
  return (prompt / 1000) * rates.promptPer1k + (completion / 1000) * rates.completionPer1k;
}

export function createProviderGateway(config: GatewayConfig, deps: GatewayDependencies = {}) {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((entry: Record<string, unknown>) => console.log(JSON.stringify(entry)));
  const breakerConfig: BreakerConfig = config.breaker;
  const breaker = new CircuitBreaker(deps.breakerStore, breakerConfig, now);
  const budgetStore: BudgetStore | null = deps.budgetStore ?? (config.budget.store === "memory" ? new InMemoryBudgetStore(now) : null);
  const policyResolver: WorkspacePolicyResolver = deps.policyResolver ?? { resolve: async () => ({ ...config.budget.defaults }) };
  const catalog = deps.models ?? MODEL_CATALOG;

  const bindingByProfile = new Map(config.bindings.map(binding => [binding.profileId, binding]));
  const adapters = new Map<string, ProviderAdapter>();
  const runtime = new Map<string, { verified: boolean; lastSuccessAt?: number; lastFailureClass?: ProviderErrorClass; lastOk: boolean | null }>();

  const adapterFor = (binding: ProviderBinding): ProviderAdapter => {
    let adapter = adapters.get(binding.providerId);
    if (!adapter) {
      adapter = deps.adapterFactory
        ? deps.adapterFactory(binding, config)
        : createOpenAiCompatibleAdapter({
            providerId: binding.providerId,
            baseUrl: binding.baseUrl,
            apiKey: binding.apiKey,
            timeoutMs: binding.timeoutMs,
            maxAttempts: config.retry.maxAttempts,
            totalDeadlineMs: config.retry.totalDeadlineMs,
            backoffBaseMs: config.retry.backoffBaseMs,
            backoffMaxMs: config.retry.backoffMaxMs,
          });
      adapters.set(binding.providerId, adapter);
    }
    return adapter;
  };

  /** Catalog profiles with runtime enablement overlaid ONLY where a validated binding exists. */
  function runtimeModels(): ModelProfile[] {
    return catalog.map(profile => {
      const binding = bindingByProfile.get(profile.id);
      if (!binding) return profile;
      return { ...profile, runtimeEnabled: true, implementationStatus: "available" as const, billingMode: binding.billingMode, providerKind: binding.kind };
    });
  }

  const touchRuntime = (providerId: string) => {
    let record = runtime.get(providerId);
    if (!record) {
      record = { verified: false, lastOk: null };
      runtime.set(providerId, record);
    }
    return record;
  };

  function usageFrom(binding: ProviderBinding, success: AdapterSuccess, estimatedTokens: number): GatewayUsage {
    const rates = config.budget.rates;
    const reported = success.usage;
    if (reported && (reported.totalTokens !== undefined || reported.promptTokens !== undefined)) {
      const usage: GatewayUsage = { source: "provider_reported", ...reported };
      if (rates && binding.billingMode === "metered_api" && reported.promptTokens !== undefined && reported.completionTokens !== undefined) {
        usage.cost = { amount: computeCost(rates, reported.promptTokens, reported.completionTokens), unit: rates.unit, basis: "configured_rate", estimated: false };
      }
      return usage;
    }
    if (binding.billingMode === "local_compute") return { source: "none" };
    return { source: "estimated", totalTokens: estimatedTokens };
  }

  async function budgetGate(binding: ProviderBinding, request: GatewayRequest, estimatedTokens: number): Promise<{ ok: true; reservation: Reservation | null } | { ok: false; detail: string }> {
    if (binding.kind !== "external" || binding.billingMode !== "metered_api") return { ok: true, reservation: null };
    if (!config.policy.allowMetered) return { ok: false, detail: "metered_not_allowed" };
    if (!budgetStore) return { ok: false, detail: "budget_store_unavailable" };
    let policy: WorkspaceBudgetPolicy;
    try {
      policy = await policyResolver.resolve(request.workspaceId);
    } catch {
      return { ok: false, detail: "policy_unavailable" };
    }
    if (!hasAnyBudgetLimit(policy)) return { ok: false, detail: "no_limits_configured" };
    const rates = config.budget.rates;
    try {
      const result = await budgetStore.reserve({
        workspaceId: request.workspaceId,
        providerId: binding.providerId,
        requestId: request.requestId,
        estimatedTokens,
        // Worst case: price every estimated token at the dearer of the two configured rates.
        // Without configured rates there is no trustworthy cost, so a cost ceiling fails closed.
        estimatedCost: rates ? (estimatedTokens / 1000) * Math.max(rates.promptPer1k, rates.completionPer1k) : undefined,
        policy,
      });
      return result.ok ? { ok: true, reservation: result.reservation } : { ok: false, detail: result.reason };
    } catch {
      return { ok: false, detail: "store_unavailable" };
    }
  }

  async function invokeInner(request: GatewayRequest): Promise<GatewayOutcome> {
    const startedAt = now();
    const attempts: AttemptRecord[] = [];
    const finish = (outcome: GatewayOutcome): GatewayOutcome => {
      log({
        event: "gateway.invoke",
        requestId: request.requestId,
        workspaceId: request.workspaceId,
        status: outcome.status,
        reason: outcome.status === "failed" ? outcome.reason : undefined,
        provider: outcome.status === "returned" ? outcome.providerId : undefined,
        sequence: attempts.map(a => `${a.providerId}:${a.outcome}`),
        latencyMs: outcome.latencyMs,
      });
      return outcome;
    };
    const failed = (reason: Extract<GatewayOutcome, { status: "failed" }>["reason"]): GatewayOutcome =>
      finish({ status: "failed", reason, attempts, latencyMs: now() - startedAt });

    const routing: RoutingRequest = {
      intents: request.intents ?? ["conversation"],
      requiredCapabilities: request.requiredCapabilities ?? ["chat"],
      optionalCapabilities: request.optionalCapabilities ?? ["multilingual"],
      allowExternalProviders: config.policy.allowExternal,
      allowMeteredBilling: config.policy.allowMetered,
      preferLocal: true, // local/self-hosted first; external only as a policy-permitted fallback
    };
    const decision = routeModel(runtimeModels(), routing);
    const ordered = [decision.selected, ...decision.alternatives].filter((c): c is NonNullable<typeof c> => !!c).map(c => c.model);
    if (!ordered.length) return failed("no_eligible_provider");

    const maxOutputTokens = request.maxOutputTokens ?? config.budget.defaultMaxOutputTokens;
    const estimatedTokens = estimateTokens(request.messages, maxOutputTokens);
    let lastFailure: ProviderErrorClass | "budget_denied" | null = null;
    const tried = new Set<string>();

    for (const profile of ordered.slice(0, config.maxCandidates)) {
      const binding = bindingByProfile.get(profile.id);
      if (!binding || tried.has(binding.providerId)) continue; // never revisit a provider: no fallback loops
      tried.add(binding.providerId);

      const admission = await breaker.admit(binding.providerId);
      if (!admission.allowed) {
        attempts.push({ providerId: binding.providerId, outcome: SKIP_CIRCUIT_OPEN });
        continue;
      }

      const gate = await budgetGate(binding, request, estimatedTokens);
      if (!gate.ok) {
        await breaker.recordNeutral(binding.providerId); // releases a held half-open probe slot
        attempts.push({ providerId: binding.providerId, outcome: `skipped:budget:${gate.detail}` });
        lastFailure = "budget_denied";
        continue;
      }

      const callStarted = now();
      try {
        const success = await adapterFor(binding).complete({ messages: request.messages, maxOutputTokens, model: binding.model });
        await breaker.recordSuccess(binding.providerId);
        const usage = usageFrom(binding, success, estimatedTokens);
        if (gate.reservation && budgetStore) {
          await budgetStore.commit(gate.reservation, {
            tokens: usage.totalTokens ?? estimatedTokens,
            cost: usage.cost?.amount,
            source: usage.source === "provider_reported" ? "provider_reported" : "estimated",
          }).catch(() => undefined);
        }
        const record = touchRuntime(binding.providerId);
        Object.assign(record, { verified: true, lastOk: true, lastSuccessAt: now(), lastFailureClass: undefined });
        attempts.push({ providerId: binding.providerId, outcome: "ok", httpAttempts: success.attempts, latencyMs: now() - callStarted });
        return finish({
          status: "returned",
          content: success.content,
          providerId: binding.providerId,
          modelId: binding.model,
          profileId: binding.profileId,
          kind: binding.kind,
          billingMode: binding.billingMode,
          usage,
          attempts,
          latencyMs: now() - startedAt,
        });
      } catch (error) {
        const failure = error instanceof ProviderCallError ? error : new ProviderCallError("network");
        const traits = ERROR_TRAITS[failure.errorClass];
        if (traits.breakerFailure) await breaker.recordFailure(binding.providerId);
        else await breaker.recordNeutral(binding.providerId);

        if (gate.reservation && budgetStore) {
          // The provider may have done (billable) work for these classes; otherwise hand the hold back.
          const possiblyBilled = failure.errorClass === "timeout" || failure.errorClass === "malformed_response" || failure.errorClass === "empty_response";
          if (possiblyBilled) await budgetStore.commit(gate.reservation, { tokens: estimatedTokens, source: "estimated" }).catch(() => undefined);
          else await budgetStore.release(gate.reservation).catch(() => undefined);
        }
        const record = touchRuntime(binding.providerId);
        Object.assign(record, { lastOk: false, lastFailureClass: failure.errorClass });
        attempts.push({ providerId: binding.providerId, outcome: failure.errorClass, httpAttempts: failure.attempts, latencyMs: now() - callStarted });
        lastFailure = failure.errorClass;
        if (!traits.allowsFallback) return failed(failure.errorClass); // auth/caller errors are terminal, never masked by fallback
      }
    }

    if (lastFailure) return failed(lastFailure);
    return failed(attempts.length ? "all_candidates_skipped" : "no_eligible_provider");
  }

  /** Never throws: any unexpected internal fault is reported as a failed outcome, never as a grounded answer. */
  async function invoke(request: GatewayRequest): Promise<GatewayOutcome> {
    const startedAt = now();
    try {
      return await invokeInner(request);
    } catch {
      log({ event: "gateway.invoke", requestId: request.requestId, workspaceId: request.workspaceId, status: "failed", reason: "internal_error" });
      return { status: "failed", reason: "internal_error", attempts: [], latencyMs: now() - startedAt };
    }
  }

  /**
   * Compatibility probe: a tiny real completion that must come back in OpenAI-compatible shape.
   * Only a successful probe (or a successful real call) yields "reachable_compatible".
   * Never invoked automatically, and refuses metered external providers (it would spend money).
   */
  async function probe(providerId: string): Promise<RuntimeState> {
    const binding = config.bindings.find(b => b.providerId === providerId);
    if (!binding) return "disabled";
    if (binding.kind === "external" && binding.billingMode === "metered_api") throw new Error("probe refused: metered external provider");
    try {
      await adapterFor(binding).complete({ messages: [{ role: "user", content: "ping" }], maxOutputTokens: 1, model: binding.model });
      await breaker.recordSuccess(providerId);
      Object.assign(touchRuntime(providerId), { verified: true, lastOk: true, lastSuccessAt: now(), lastFailureClass: undefined });
    } catch (error) {
      const failure = error instanceof ProviderCallError ? error : new ProviderCallError("network");
      if (ERROR_TRAITS[failure.errorClass].breakerFailure) await breaker.recordFailure(providerId);
      Object.assign(touchRuntime(providerId), { lastOk: false, lastFailureClass: failure.errorClass });
    }
    return (await statusOf(providerId)).state;
  }

  async function statusOf(providerId: string): Promise<ProviderRuntimeStatus> {
    const binding = config.bindings.find(b => b.providerId === providerId);
    const invalid = config.invalid.find(item => item.providerId === providerId);
    const kindOf = (id: string) => (id.startsWith("local") ? "self_hosted" : "external") as ProviderRuntimeStatus["kind"];
    if (!binding) {
      return { providerId, profileId: "", kind: kindOf(providerId), billingMode: providerId.startsWith("local") ? "local_compute" : "metered_api", state: invalid ? "invalid_configuration" : "disabled", breaker: "CLOSED" };
    }
    const breakerState = await breaker.state(providerId);
    const record = runtime.get(providerId);
    let state: RuntimeState = "configured_unverified";
    if (breakerState !== "CLOSED" || record?.lastOk === false) state = "unhealthy";
    else if (record?.verified && record.lastOk === true) state = "reachable_compatible";
    return {
      providerId,
      profileId: binding.profileId,
      kind: binding.kind,
      billingMode: binding.billingMode,
      state,
      breaker: breakerState,
      lastSuccessAt: record?.lastSuccessAt,
      lastFailureClass: record?.lastFailureClass,
    };
  }

  async function status(): Promise<ProviderRuntimeStatus[]> {
    const ids = new Set<string>(["local-openai-compatible", "external-openai-compatible"]);
    for (const binding of config.bindings) ids.add(binding.providerId);
    return Promise.all([...ids].map(statusOf));
  }

  return { invoke, probe, status, breaker, budgetStore };
}

export type ProviderGateway = ReturnType<typeof createProviderGateway>;
