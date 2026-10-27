import type { Limits } from "./engine/types";

/** Durable task type handled by the Sentinel investigation worker. */
export const SENTINEL_INVESTIGATE_TASK = "sentinel.investigate";

/**
 * Default-OFF feature flag. Sentinel runs only when SENTINEL_ENABLED === "true" AND the shared task worker runtime is enabled
 * (TASK_WORKER_ENABLED === "true"). With the flag off: no handler is registered, the API refuses create/cancel, and nothing here touches the
 * database or any connector.
 */
export const sentinelEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.SENTINEL_ENABLED === "true";

const int = (v: string | undefined, d: number, lo: number, hi: number): number => { const n = Number(v); return Number.isInteger(n) && n >= lo && n <= hi ? n : d; };

export interface SentinelRuntimeConfig {
  /** wall-clock limit for one model decision */ policyTimeoutMs: number;
  /** wall-clock limit for one diagnostic tool attempt */ toolAttemptTimeoutMs: number;
  /** hard cap on model calls per investigation attempt chain (including format retries) */ maxModelCalls: number;
  formatRetries: number;
  /** how often the cancel flag of the durable task is polled while a call is in flight */ cancelPollMs: number;
}
export const sentinelRuntimeConfig = (env: NodeJS.ProcessEnv = process.env): SentinelRuntimeConfig => ({
  policyTimeoutMs: int(env.SENTINEL_POLICY_TIMEOUT_MS, 120_000, 1000, 900_000),
  toolAttemptTimeoutMs: int(env.SENTINEL_TOOL_TIMEOUT_MS, 20_000, 500, 120_000),
  maxModelCalls: int(env.SENTINEL_MAX_MODEL_CALLS, 24, 1, 100),
  formatRetries: int(env.SENTINEL_FORMAT_RETRIES, 1, 0, 3),
  cancelPollMs: int(env.SENTINEL_CANCEL_POLL_MS, 500, 50, 10_000),
});

/**
 * Most investigations a workspace may have QUEUED or RUNNING at once (default 5, 1-50). Each one can make up to SENTINEL_MAX_MODEL_CALLS model calls
 * and several connector calls; without a cap one member could fill the shared task queue and the model budget. A soft bound: two creates racing
 * each other may overshoot by the number of racers.
 */
export const sentinelMaxActive = (env: NodeJS.ProcessEnv = process.env): number => int(env.SENTINEL_MAX_ACTIVE_PER_WORKSPACE, 5, 1, 50);

/** Ceilings a caller cannot exceed, and the defaults used when a field is omitted. `max_virtual_ms` is wall milliseconds in production. */
export const LIMIT_CEILINGS: Readonly<Limits> = Object.freeze({ max_tool_calls: 15, max_steps: 20, max_retries_per_call: 2, max_virtual_ms: 600_000 });
export const LIMIT_DEFAULTS: Readonly<Limits> = Object.freeze({ max_tool_calls: 8, max_steps: 12, max_retries_per_call: 1, max_virtual_ms: 180_000 });

export const clampLimits = (requested: Partial<Limits> | undefined): Limits => {
  const out = { ...LIMIT_DEFAULTS } as Limits;
  for (const k of Object.keys(LIMIT_DEFAULTS) as Array<keyof Limits>) {
    const v = requested?.[k];
    if (v === undefined) continue;
    const floor = k === "max_retries_per_call" ? 0 : 1;
    out[k] = Math.min(LIMIT_CEILINGS[k], Math.max(floor, Math.floor(v)));
  }
  return out;
};

/** Tenant string the engine and diagnostic adapter agree on. Derived from the authoritative workspace id, never from any payload. */
export const tenantOf = (workspaceId: number): string => `ws-${workspaceId}`;
