import type { UploadStore } from "./store";

export type CleanupConfig = { enabled: boolean; intervalMs: number; batchLimit: number; maxBatchesPerRun: number; retentionDays: number; finalizingStaleSeconds: number };
const int = (v: string | undefined, d: number, lo: number, hi: number) => { const n = Number(v); return Number.isInteger(n) && n >= lo && n <= hi ? n : d; };

/** Default-safe: OFF unless UPLOAD_CLEANUP_ENABLED === "true". Running it never enables uploads (that stays behind FILE_INGESTION_BACKEND_ENABLED + scanner). */
export function cleanupConfigFromEnv(env: NodeJS.ProcessEnv = process.env): CleanupConfig {
  return {
    enabled: env.UPLOAD_CLEANUP_ENABLED === "true",
    intervalMs: int(env.UPLOAD_CLEANUP_INTERVAL_MS, 600_000, 1_000, 86_400_000),
    batchLimit: int(env.UPLOAD_CLEANUP_BATCH_LIMIT, 200, 1, 5_000),
    maxBatchesPerRun: int(env.UPLOAD_CLEANUP_MAX_BATCHES, 10, 1, 100),
    retentionDays: int(env.UPLOAD_CLEANUP_RETENTION_DAYS, 7, 1, 365),
    finalizingStaleSeconds: int(env.UPLOAD_CLEANUP_FINALIZING_STALE_SECONDS, 300, 60, 86_400),
  };
}

export type CleanupTotals = { expired: number; recovered: number; purgedChunkRows: number; deletedSessions: number };
export type CleanupStatus = {
  enabled: boolean; state: "disabled" | "stopped" | "idle" | "running" | "stopping";
  runs: number; skippedBusy: number; consecutiveErrors: number; lastError: string | null;
  lastRunAt: string | null; lastDurationMs: number | null; lastTruncated: boolean; totals: CleanupTotals; healthy: boolean;
};
export type RunOutcome = { status: "ran"; batches: number; truncated: boolean; report: CleanupTotals } | { status: "skipped_busy" } | { status: "skipped_disabled" } | { status: "error" };

export class UploadCleanupRunner {
  private timer: NodeJS.Timeout | null = null;
  private current: Promise<RunOutcome> | null = null;
  private started = false; private stopping = false;
  private runs = 0; private skippedBusy = 0; private consecutiveErrors = 0; private lastError: string | null = null;
  private lastRunAt: Date | null = null; private lastDurationMs: number | null = null; private lastTruncated = false;
  private totals: CleanupTotals = { expired: 0, recovered: 0, purgedChunkRows: 0, deletedSessions: 0 };
  constructor(private readonly deps: { store: Pick<UploadStore, "cleanup">; config: CleanupConfig; log?: (line: string) => void }) {}

  status(): CleanupStatus {
    const state: CleanupStatus["state"] = !this.deps.config.enabled ? "disabled" : this.stopping ? "stopping" : this.current ? "running" : this.started ? "idle" : "stopped";
    return { enabled: this.deps.config.enabled, state, runs: this.runs, skippedBusy: this.skippedBusy, consecutiveErrors: this.consecutiveErrors, lastError: this.lastError, lastRunAt: this.lastRunAt?.toISOString() ?? null, lastDurationMs: this.lastDurationMs, lastTruncated: this.lastTruncated, totals: { ...this.totals }, healthy: this.consecutiveErrors < 3 };
  }

  start(): void {
    if (!this.deps.config.enabled || this.started) return;
    this.started = true; this.stopping = false;
    this.timer = setInterval(() => { void this.runOnce(); }, this.deps.config.intervalMs);
    this.timer.unref?.();
  }

  /** Single-flight: a second call while a run is in progress is skipped, never queued or overlapped. */
  runOnce(): Promise<RunOutcome> {
    if (!this.deps.config.enabled) return Promise.resolve({ status: "skipped_disabled" });
    if (this.current || this.stopping) { this.skippedBusy += 1; return Promise.resolve({ status: "skipped_busy" }); }
    const run = this.execute().finally(() => { this.current = null; });
    this.current = run;
    return run;
  }

  private async execute(): Promise<RunOutcome> {
    const { config } = this.deps; const began = Date.now();
    const sum: CleanupTotals = { expired: 0, recovered: 0, purgedChunkRows: 0, deletedSessions: 0 };
    let batches = 0; let truncated = false;
    try {
      // Bounded: at most maxBatchesPerRun batches of batchLimit rows; leftover work waits for the next interval.
      do {
        if (this.stopping) break;
        const r = await this.deps.store.cleanup({ batchLimit: config.batchLimit, retentionDays: config.retentionDays, finalizingStaleSeconds: config.finalizingStaleSeconds });
        batches += 1; truncated = r.truncated;
        for (const k of Object.keys(sum) as Array<keyof CleanupTotals>) sum[k] += r[k];
      } while (truncated && batches < config.maxBatchesPerRun);
      this.consecutiveErrors = 0; this.lastError = null;
      for (const k of Object.keys(sum) as Array<keyof CleanupTotals>) this.totals[k] += sum[k];
      this.runs += 1; this.lastRunAt = new Date(); this.lastDurationMs = Date.now() - began; this.lastTruncated = truncated;
      this.deps.log?.(JSON.stringify({ event: "upload_cleanup", batches, truncated, ...sum, durationMs: this.lastDurationMs }));
      return { status: "ran", batches, truncated, report: sum };
    } catch (error) {
      this.consecutiveErrors += 1; this.lastError = (error instanceof Error ? error.message : "cleanup error").slice(0, 160);
      this.lastRunAt = new Date(); this.lastDurationMs = Date.now() - began;
      this.deps.log?.(JSON.stringify({ event: "upload_cleanup_error", consecutiveErrors: this.consecutiveErrors }));
      return { status: "error" };
    }
  }

  /** Stops the schedule and waits (up to graceMs) for an in-progress run; a run cut off mid-batch is safe (every statement is atomic and idempotent). */
  async stop(graceMs = 10_000): Promise<{ drained: boolean }> {
    if (!this.started) return { drained: true };
    this.stopping = true;
    if (this.timer) clearInterval(this.timer); this.timer = null;
    let timer: NodeJS.Timeout | undefined;
    const drained = this.current ? await Promise.race([this.current.then(() => true, () => true), new Promise<boolean>(r => { timer = setTimeout(() => r(false), graceMs); })]) : true;
    if (timer) clearTimeout(timer);
    this.started = false; this.stopping = false;
    return { drained };
  }
}
