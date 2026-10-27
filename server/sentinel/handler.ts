import { z } from "zod";
import { TaskCancelledError, TaskFatalError, TaskLeaseLostError, TaskRetryableError } from "../tasks/types";
import type { TaskContext, TaskHandler } from "../tasks/worker";
import { caseFromRecord } from "./caseDoc";
import { clampLimits, sentinelEnabled, sentinelRuntimeConfig } from "./config";
import type { SentinelRuntimeConfig } from "./config";
import { McpDiagnosticTransport } from "./adapters/mcpDiagnosticTransport";
import type { McpDiagnosticOptions } from "./adapters/mcpDiagnosticTransport";
import type { Checkpoint } from "./engine/checkpoint";
import { GatewayPolicy } from "./engine/gateway_policy";
import type { ModelTransport } from "./engine/model_transport";
import { investigateAsync } from "./engine/orchestrator";
import type { CancelToken, RunResult } from "./engine/orchestrator";
import { verifyChain } from "./engine/trace";
import type { TraceEvent } from "./engine/trace";
import type { ToolTransport } from "./engine/transport";
import { checkpointFromEvents, isFinished, summaryFromEvents } from "./replay";
import type { FinalSummary } from "./replay";
import type { SentinelStore } from "./store";
import { DEFAULT_TAXONOMY } from "./taxonomy";
import { TaskModelTransport } from "./taskModelTransport";
import { isTerminalStatus } from "./types";
import type { InvestigationRecord, StoredEvent } from "./types";

/** Task payload: ONLY the investigation id. Everything else is loaded from the workspace-scoped row, so a payload can never widen scope. */
export const sentinelInput = z.object({ investigationId: z.string().uuid() }).strict();
export type SentinelTaskInput = z.infer<typeof sentinelInput>;
export type SentinelTaskResult = { investigationId: string; status: string; stopReason: string | null; outcome: string | null; label: string | null; verified: boolean | null; eventCount: number; traceHead: string | null };

type ProviderModel = ModelTransport & { lastError?: TaskRetryableError | TaskFatalError | null };
export interface SentinelHandlerDeps {
  store: SentinelStore;
  /** the existing McpConnectorService (only callTool is used) */ mcp: McpDiagnosticOptions["service"];
  enabled?: () => boolean;
  config?: () => SentinelRuntimeConfig;
  /** tests: replace the diagnostic adapter */ transportFor?: (row: InvestigationRecord) => ToolTransport;
  /** tests: replace the model transport (production uses the gateway via ctx.invokeModel) */ modelFor?: (ctx: TaskContext) => ProviderModel;
}

const toStored = (e: TraceEvent): StoredEvent => ({ seq: e.seq, type: e.type, vt: e.vt, payload: e.payload, prev: e.prev, hash: e.hash });
const resultOf = (id: string, s: FinalSummary): SentinelTaskResult => ({ investigationId: id, status: s.status, stopReason: s.stopReason, outcome: s.outcome, label: s.label, verified: s.verified, eventCount: s.eventCount, traceHead: s.traceHead });

/** Model calls already spent in earlier attempts (each persisted decision records which format-retry attempt produced it). */
const priorModelCalls = (events: StoredEvent[]): number =>
  events.filter((e) => e.type === "decision").reduce((n, e) => n + 1 + Number((e.payload as { model_meta?: { attempt?: number } }).model_meta?.attempt ?? 0), 0);

/**
 * sentinel.investigate - durable, resumable, cancellable read-only incident investigation.
 *
 * Reuses (does not replace) the task worker: lease/heartbeat/cancel come from TaskContext, model calls go through ctx.invokeModel (tenant-pinned
 * Provider Gateway), diagnostics go through McpConnectorService.callTool (read-only, workspace-scoped, audited). State is event-sourced:
 * the hash-chained trace is appended to the store at every checkpoint, the task checkpoint only carries a pointer, and a retry/restart
 * rebuilds the engine checkpoint from the stored events (re-validated by the engine before it continues).
 *
 * At-least-once window: a crash between "tool_request" and "tool_result" re-executes that one READ-ONLY call on resume. Nothing here writes
 * to a target system: write tools are denied by the broker and cannot be bound.
 */
export function createSentinelInvestigateHandler(deps: SentinelHandlerDeps): TaskHandler<unknown, { investigationId: string; seq: number; traceHead: string }> {
  const enabled = deps.enabled ?? (() => sentinelEnabled());
  const cfgOf = deps.config ?? (() => sentinelRuntimeConfig());
  return async (ctx) => {
    if (!enabled()) throw new TaskFatalError("sentinel is disabled", "POLICY_DENIED");
    const parsed = sentinelInput.safeParse(ctx.input);
    if (!parsed.success) throw new TaskFatalError("invalid sentinel.investigate input", "NON_RETRYABLE");
    const id = parsed.data.investigationId;
    const workspaceId = ctx.task.workspaceId;               // tenant: ALWAYS the task's workspace
    const row = await deps.store.get(workspaceId, id);
    if (!row) throw new TaskFatalError("investigation not found in task workspace", "NON_RETRYABLE");
    if (row.taskId && row.taskId !== ctx.task.id) throw new TaskFatalError("investigation is bound to another task", "NON_RETRYABLE");
    const cfg = cfgOf();

    const stored = await deps.store.readEvents(workspaceId, id);
    const chain = verifyChain(stored as TraceEvent[], row.id);
    if (!chain.ok) throw new TaskFatalError("stored investigation trace failed its integrity check", "NON_RETRYABLE");

    // Crash window: terminal events written but the row not yet finalised -> finish from the events, run nothing.
    if (isFinished(stored)) {
      const s = summaryFromEvents(stored)!;
      await deps.store.finalize(workspaceId, id, s);
      if (s.status === "CANCELLED") throw new TaskCancelledError();
      return resultOf(id, s);
    }
    if (isTerminalStatus(row.status)) return { investigationId: id, status: row.status, stopReason: row.stopReason, outcome: row.outcome, label: row.label, verified: row.verified, eventCount: row.eventCount, traceHead: row.traceHead };

    await deps.store.markRunning(workspaceId, id);
    const caseDoc = caseFromRecord({ ...row, limits: clampLimits(row.limits) });
    let resumeFrom: Checkpoint | undefined;
    try { resumeFrom = checkpointFromEvents(row.id, stored) ?? undefined; }
    catch { throw new TaskFatalError("stored investigation could not be resumed", "NON_RETRYABLE"); }

    const model: ProviderModel = deps.modelFor?.(ctx) ?? new TaskModelTransport(ctx);
    const policy = new GatewayPolicy(model, { maxModelCalls: Math.max(1, cfg.maxModelCalls - priorModelCalls(stored)), formatRetries: cfg.formatRetries });
    const transport: ToolTransport = deps.transportFor?.(row) ?? new McpDiagnosticTransport({ service: deps.mcp, workspaceId, userId: row.createdByUserId, tenant: caseDoc.tenant, bindings: row.bindings });

    const token: CancelToken = { cancelled: false };
    let leaseLost = false;
    const poll = setInterval(() => {
      try { ctx.throwIfCancelled(); }
      catch (e) { if (e instanceof TaskLeaseLostError) leaseLost = true; token.cancelled = true; }
    }, cfg.cancelPollMs);
    poll.unref?.();

    let persisted = stored.length;
    const flush = async (cp: Checkpoint): Promise<void> => {
      const fresh = cp.trace.slice(persisted);
      if (!fresh.length) return;
      const percent = Math.min(95, Math.round((cp.step / Math.max(1, caseDoc.limits.max_steps)) * 90));
      try { await ctx.saveCheckpoint({ investigationId: id, seq: cp.trace.length, traceHead: cp.trace_head }, { percent, note: `step ${cp.step} ${cp.phase === "AWAIT_TOOL" ? "calling tool" : "deciding"}` }); }
      catch (e) { if (e instanceof TaskCancelledError) token.cancelled = true; else throw e; }   // lease loss propagates and nothing further is written
      await deps.store.appendEvents(workspaceId, id, fresh.map(toStored));
      persisted = cp.trace.length;
    };

    let result: RunResult;
    try {
      result = await investigateAsync(caseDoc, {
        policy, transport, taxonomy: { ...DEFAULT_TAXONOMY }, cancel: token,
        verify: { requireSignatureSupport: false, signatureKb: "off" }, strictLedger: true,
        policyTimeoutMs: cfg.policyTimeoutMs, toolAttemptTimeoutMs: cfg.toolAttemptTimeoutMs, cancelPollMs: Math.min(cfg.cancelPollMs, 250),
        onCheckpoint: flush, ...(resumeFrom ? { resumeFrom } : {}),
      });
    } finally { clearInterval(poll); }
    if (leaseLost) throw new TaskLeaseLostError();

    // Provider trouble with attempts left: do NOT record a terminal outcome; the worker retries with backoff and resumes from the stored events.
    const providerStop = result.stop_reason === "POLICY_ERROR" || result.stop_reason === "POLICY_TIMEOUT";
    if (providerStop && ctx.attempt < ctx.task.maxAttempts && (model.lastError instanceof TaskRetryableError || result.stop_reason === "POLICY_TIMEOUT")) {
      throw model.lastError instanceof TaskRetryableError ? model.lastError : new TaskRetryableError("model decision timed out", "PROVIDER_UNAVAILABLE");
    }

    const rest = result.trace.slice(persisted).map(toStored);
    if (rest.length) await deps.store.appendEvents(workspaceId, id, rest);
    const all = result.trace.map(toStored);          // the engine trace begins with the stored prefix (resume rebuilds from it)
    const summary = summaryFromEvents(all);
    if (!summary) throw new TaskFatalError("investigation ended without a closing event", "INTERNAL");
    await deps.store.finalize(workspaceId, id, summary);
    if (summary.status === "CANCELLED") throw new TaskCancelledError();
    return resultOf(id, summary);
  };
}
