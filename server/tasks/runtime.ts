import { randomUUID } from "node:crypto";
import type { MysqlTaskStore } from "./store";
import { TaskWorker, type TaskGatewayPort, type TaskHandler } from "./worker";

export type RuntimeConfig = { enabled: boolean; concurrency: number; pollMs: number; leaseMs: number; shutdownGraceMs: number };
const int = (v: string | undefined, d: number, lo: number, hi: number) => { const n = Number(v); return Number.isInteger(n) && n >= lo && n <= hi ? n : d; };

/** Default-safe: the worker runtime is OFF unless TASK_WORKER_ENABLED === "true". */
export function runtimeConfigFromEnv(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  return {
    enabled: env.TASK_WORKER_ENABLED === "true",
    concurrency: int(env.TASK_WORKER_CONCURRENCY, 2, 1, 8),
    pollMs: int(env.TASK_WORKER_POLL_MS, 1000, 50, 60_000),
    leaseMs: int(env.TASK_WORKER_LEASE_MS, 30_000, 300, 600_000),
    shutdownGraceMs: int(env.TASK_WORKER_SHUTDOWN_GRACE_MS, 15_000, 0, 120_000),
  };
}

export type RuntimeStatus = {
  enabled: boolean; state: "disabled" | "stopped" | "running" | "stopping"; concurrency: number; inFlight: number;
  processed: number; consecutiveErrors: number; lastError: string | null; lastActivityAt: string | null; healthy: boolean;
};

export type RuntimeOptions = { store: MysqlTaskStore; handlers: Record<string, TaskHandler<any, any>>; gateway?: TaskGatewayPort; config: RuntimeConfig; backoffBaseMs?: number; backoffMaxMs?: number };

const UNHEALTHY_AFTER = 5;

/** Bounded-concurrency worker pool. A failing store/handler never propagates into the HTTP process. */
export class TaskWorkerRuntime {
  private state: RuntimeStatus["state"];
  private inFlight = 0;
  private processed = 0;
  private consecutiveErrors = 0;
  private lastError: string | null = null;
  private lastActivityAt: Date | null = null;
  private stopping = false;
  private loops: Promise<void>[] = [];
  private workers: TaskWorker[] = [];
  private wake: Array<() => void> = [];
  private readonly instance = randomUUID().slice(0, 8);

  constructor(private readonly options: RuntimeOptions) { this.state = options.config.enabled ? "stopped" : "disabled"; }

  status(): RuntimeStatus {
    return { enabled: this.options.config.enabled, state: this.state, concurrency: this.options.config.concurrency, inFlight: this.inFlight, processed: this.processed, consecutiveErrors: this.consecutiveErrors, lastError: this.lastError, lastActivityAt: this.lastActivityAt?.toISOString() ?? null, healthy: this.consecutiveErrors < UNHEALTHY_AFTER };
  }

  start(): void {
    if (!this.options.config.enabled || this.state === "running" || this.state === "stopping") return;
    this.stopping = false; this.state = "running";
    for (let slot = 0; slot < this.options.config.concurrency; slot++) this.loops.push(this.loop(slot));
  }

  private sleep(ms: number) {
    return new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); this.wake = this.wake.filter(w => w !== finish); resolve(); };
      const timer = setTimeout(finish, ms);
      timer.unref?.();
      this.wake.push(finish);
    });
  }

  private async loop(slot: number): Promise<void> {
    const { config } = this.options;
    const worker = new TaskWorker({ store: this.options.store, handlers: this.options.handlers, gateway: this.options.gateway, owner: `rt-${this.instance}-${slot}`, leaseMs: config.leaseMs, backoffBaseMs: this.options.backoffBaseMs, backoffMaxMs: this.options.backoffMaxMs });
    this.workers.push(worker);
    let errorBackoff = config.pollMs;
    while (!this.stopping) {
      try {
        this.inFlight += 1;
        let result;
        try { result = await worker.runOnce(); } finally { this.inFlight -= 1; }
        this.consecutiveErrors = 0; errorBackoff = config.pollMs;
        if (result.status === "idle") { await this.sleep(config.pollMs); continue; }
        this.processed += 1; this.lastActivityAt = new Date();
      } catch (error) {
        this.consecutiveErrors += 1;
        this.lastError = (error instanceof Error ? error.message : "worker error").slice(0, 200);
        errorBackoff = Math.min(30_000, errorBackoff * 2);
        await this.sleep(errorBackoff);
      }
    }
  }

  /**
   * Stops claiming new work and waits up to graceMs for in-flight tasks. Unfinished tasks keep their lease and are resumed
   * from their last checkpoint by another runtime once the lease expires (no duplicate effects: effects are durably deduped).
   */
  async stop(graceMs = this.options.config.shutdownGraceMs): Promise<{ drained: boolean; abandonedInFlight: number }> {
    if (this.state !== "running") return { drained: true, abandonedInFlight: 0 };
    this.state = "stopping"; this.stopping = true;
    this.wake.slice().forEach(w => w());
    let timer: NodeJS.Timeout | undefined;
    const drained = await Promise.race([
      Promise.allSettled(this.loops).then(() => true),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), graceMs); }),
    ]);
    if (timer) clearTimeout(timer);
    const abandonedInFlight = drained ? 0 : this.inFlight;
    if (!drained) for (const w of this.workers) w.abandon();
    this.loops = []; this.workers = []; this.state = "stopped";
    return { drained, abandonedInFlight };
  }
}
