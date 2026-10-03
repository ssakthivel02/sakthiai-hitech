import { randomUUID } from "node:crypto";
import type { GatewayOutcome, GatewayRequest } from "../gateway/types";
import { MysqlTaskStore } from "./store";
import { TaskCancelledError, TaskFatalError, TaskLeaseLostError, TaskRetryableError, type TaskFailureClass, type TaskRecord } from "./types";

/**
 * Provider-neutral worker. Task state is durable in MySQL, so any worker instance (another process after a restart)
 * can resume a task from its last checkpoint. The worker never marks success unless the handler returned.
 *
 * Model calls MUST go through ctx.invokeModel: it pins the tenant (task.workspaceId), runs through the Provider Gateway
 * (policy, budget, circuit breaker) on every attempt, and classifies refusals so a retry can never bypass policy/budget.
 */
export interface TaskGatewayPort { invoke(request: GatewayRequest): Promise<GatewayOutcome> }

export type TaskContext<I = unknown, C = unknown> = {
  task: TaskRecord;
  input: I;
  /** Last durable checkpoint (null on the first attempt). */
  checkpoint: C | null;
  attempt: number;
  /** Persist progress. Throws TaskLeaseLostError / TaskCancelledError when the handler must stop. */
  saveCheckpoint(data: C, progress?: { percent?: number; note?: string }): Promise<void>;
  /** Throws TaskCancelledError if cancellation was requested. */
  throwIfCancelled(): void;
  /** At-least-once side effect with durable dedupe: a completed effect is replayed from its recorded result on resume/retry. */
  effect<T>(key: string, run: () => Promise<T>): Promise<T>;
  invokeModel(request: Omit<GatewayRequest, "workspaceId" | "requestId"> & { requestId?: string }): Promise<string>;
};
export type TaskHandler<I = unknown, C = unknown> = (ctx: TaskContext<I, C>) => Promise<unknown>;

export type WorkerOptions = {
  store: MysqlTaskStore;
  handlers: Record<string, TaskHandler<any, any>>;
  gateway?: TaskGatewayPort;
  owner?: string;
  leaseMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
};
export type RunResult = { status: "idle" } | { status: "succeeded" | "waiting" | "failed" | "cancelled" | "lease_lost"; taskId: string };

export const backoffFor = (attempt: number, baseMs: number, maxMs: number) => Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));

/** Maps a refused/failed gateway outcome to a task failure. Budget/policy refusals and caller faults are never retried. */
export function failureFromGateway(outcome: Extract<GatewayOutcome, { status: "failed" }>): TaskRetryableError | TaskFatalError {
  switch (outcome.reason) {
    case "budget_denied": return new TaskFatalError("provider budget denied", "BUDGET_DENIED");
    case "policy_denied": return new TaskFatalError("provider policy denied", "POLICY_DENIED");
    case "auth_failed": case "bad_request": return new TaskFatalError(`provider rejected the request (${outcome.reason})`, "NON_RETRYABLE");
    default: return new TaskRetryableError(`model provider unavailable (${outcome.reason})`, "PROVIDER_UNAVAILABLE");
  }
}

export class TaskWorker {
  readonly owner: string;
  private readonly leaseMs: number;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  constructor(private readonly options: WorkerOptions) {
    this.owner = options.owner ?? `worker-${randomUUID()}`;
    this.leaseMs = options.leaseMs ?? 30_000;
  }

  async runOnce(): Promise<RunResult> {
    const { store } = this.options;
    const types = Object.keys(this.options.handlers);
    const task = await store.claim(this.owner, { leaseMs: this.leaseMs, types });
    if (!task) return { status: "idle" };
    const handler = this.options.handlers[task.type];
    const attempt = task.attempt;
    let lost = false;
    let cancelled = task.cancelRequested;
    let seq = task.checkpointSeq;
    const heartbeat = setInterval(() => {
      store.heartbeat(task.id, this.owner, attempt, this.leaseMs).then(r => { if (!r.ok) lost = true; else if (r.cancelRequested) cancelled = true; }).catch(() => undefined);
    }, Math.max(10, Math.floor(this.leaseMs / 3)));
    heartbeat.unref?.();

    const stopIfNeeded = () => { if (lost) throw new TaskLeaseLostError(); if (cancelled) throw new TaskCancelledError(); };
    const ctx: TaskContext = {
      task, input: task.input, checkpoint: task.checkpoint, attempt,
      throwIfCancelled: stopIfNeeded,
      saveCheckpoint: async (data, progress) => {
        stopIfNeeded();
        seq += 1;
        const saved = await store.checkpoint(task.id, this.owner, attempt, { seq, data, progressPercent: progress?.percent, progressNote: progress?.note, leaseMs: this.leaseMs });
        if (!saved.ok) { lost = true; throw new TaskLeaseLostError(); }
        if (saved.cancelRequested) { cancelled = true; throw new TaskCancelledError(); }
      },
      effect: async <T,>(key: string, run: () => Promise<T>) => {
        stopIfNeeded();
        const known = await store.getEffect(task.id, key);
        if (known.found) return known.result as T;
        const value = await run();
        await store.recordEffect(task.id, key, value);
        return value;
      },
      invokeModel: async request => {
        stopIfNeeded();
        if (!this.options.gateway) throw new TaskFatalError("no provider gateway configured", "POLICY_DENIED");
        let outcome: GatewayOutcome;
        try {
          // workspaceId is pinned to the task's tenant; the gateway applies policy + budget + breaker on EVERY attempt.
          outcome = await this.options.gateway.invoke({ ...request, workspaceId: task.workspaceId, requestId: request.requestId ?? `${task.id}:${attempt}` });
        } catch {
          throw new TaskRetryableError("provider gateway error", "INTERNAL");
        }
        if (outcome.status === "failed") throw failureFromGateway(outcome);
        return outcome.content;
      },
    };

    try {
      if (!handler) throw new TaskFatalError(`no handler for task type ${task.type}`);
      stopIfNeeded();
      const result = await handler(ctx);
      clearInterval(heartbeat);
      return (await store.complete(task.id, this.owner, attempt, result ?? null)) ? { status: "succeeded", taskId: task.id } : { status: "lease_lost", taskId: task.id };
    } catch (error) {
      clearInterval(heartbeat);
      if (error instanceof TaskLeaseLostError) return { status: "lease_lost", taskId: task.id };
      if (error instanceof TaskCancelledError) return (await store.markCancelled(task.id, this.owner, attempt)) ? { status: "cancelled", taskId: task.id } : { status: "lease_lost", taskId: task.id };
      const fatal = error instanceof TaskFatalError;
      const failureClass: TaskFailureClass = fatal || error instanceof TaskRetryableError ? (error as TaskFatalError | TaskRetryableError).failureClass : "INTERNAL";
      const message = error instanceof Error ? error.message : "task failed";
      const explicit = error instanceof TaskRetryableError ? error.backoffMs : undefined;
      const outcome = await store.fail(task.id, this.owner, attempt, {
        failureClass, message, retryable: !fatal,
        backoffMs: explicit ?? backoffFor(attempt, this.options.backoffBaseMs ?? 1000, this.options.backoffMaxMs ?? 300_000),
      });
      return outcome === "LOST" ? { status: "lease_lost", taskId: task.id } : { status: outcome === "WAITING" ? "waiting" : "failed", taskId: task.id };
    } finally {
      clearInterval(heartbeat);
    }
  }

  /** In-process polling loop (no external queue required). Safe to run on many instances. */
  start(pollMs = 1000) {
    if (this.timer) return;
    const tick = async () => {
      if (this.running) return;
      this.running = true;
      try { while ((await this.runOnce()).status !== "idle") { /* drain */ } } catch { /* store unavailable: try again next tick */ } finally { this.running = false; }
    };
    this.timer = setInterval(() => { void tick(); }, pollMs);
    this.timer.unref?.();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
}
