import { TaskFatalError, TaskRetryableError } from "../tasks/types";
import type { TaskContext } from "../tasks/worker";
import type { ModelRequest, ModelResponse, ModelTransport } from "./engine/model_transport";
import type { ModelProvenance } from "./engine/types";
import type { ModelCallMeta } from "../gateway/provenance";

/**
 * Adapter from the engine's ModelTransport seam to the EXISTING durable-task model path (TaskContext.invokeModel -> Provider Gateway).
 * It adds no provider code: tenant pinning, policy, budget and circuit breaking are all enforced by the gateway on every call.
 * Provider failures are remembered (`lastError`) so the handler can decide between "let the task retry with backoff" and "record a truthful
 * model-unavailable outcome", exactly like chat.answer.
 */
export class TaskModelTransport implements ModelTransport {
  readonly id = "gateway"; readonly kind = "remote" as const;
  lastError: TaskRetryableError | TaskFatalError | null = null;
  constructor(private readonly ctx: Pick<TaskContext, "invokeModel" | "throwIfCancelled"> & Partial<Pick<TaskContext, "invokeModelDetailed">>) {}
  async complete(req: ModelRequest): Promise<ModelResponse> {
    this.ctx.throwIfCancelled();
    try {
      const request = {
        messages: [{ role: "system" as const, content: req.system }, { role: "user" as const, content: req.user }],
        intents: ["analysis" as const], requiredCapabilities: ["chat" as const, "reasoning" as const], optionalCapabilities: ["structured_output" as const],
      };
      // Prefer the detailed call so the trace can say which provider/model answered. A context without it (older callers) still works;
      // the response then carries no provenance and the report says UNVERIFIED instead of guessing.
      if (this.ctx.invokeModelDetailed) {
        const { content, meta } = await this.ctx.invokeModelDetailed(request);
        if (!meta) return { text: content };
        return { text: content, ...(meta.usage.promptTokens !== undefined ? { tokens_in: meta.usage.promptTokens } : {}), ...(meta.usage.completionTokens !== undefined ? { tokens_out: meta.usage.completionTokens } : {}), provenance: toProvenance(meta) };
      }
      return { text: await this.ctx.invokeModel(request) };
    } catch (e) {
      if (e instanceof TaskRetryableError || e instanceof TaskFatalError) this.lastError = e;
      throw e;
    }
  }
}

export const toProvenance = (m: ModelCallMeta): ModelProvenance => ({
  provider_id: m.providerId, model_id: m.modelId, profile_id: m.profileId, provider_kind: m.providerKind, billing_mode: m.billingMode, config_source: m.configSource,
  usage_source: m.usage.source, latency_ms: m.latencyMs, runtime_class: m.runtimeClass, ...(m.endpointProfile ? { endpoint_profile: m.endpointProfile } : {}), ...(m.invokedAt ? { invoked_at: m.invokedAt } : {}), ...(m.correlationId ? { correlation_id: m.correlationId } : {}), verification: m.verification, fallback_occurred: m.fallbackOccurred, ...(m.usage.cost ? { cost: m.usage.cost } : {}), gateway_attempts: m.attempts.map((a) => ({ provider_id: a.providerId, outcome: a.outcome, ...(a.httpAttempts !== undefined ? { http_attempts: a.httpAttempts } : {}), ...(a.latencyMs !== undefined ? { latency_ms: a.latencyMs } : {}) })),
});
