import { sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/mysql2";
import { InMemoryRateLimiter, type RateLimitDecision, type RateLimitPolicy } from "./rateLimit";

/**
 * Authenticated request limits shared by every server instance (RATE_LIMIT_STORE=mysql).
 *
 * Counting: one fixed-window row per (policy, user) in `rateLimitWindows` (migration 0013), aligned to windowMs.
 * Upsert and read of that row run in one transaction, so InnoDB row locking admits exactly `maxRequests` per window
 * across the fleet. A lagging clock cannot reset a newer window.
 *
 * Failure policy (explicit, per policy; see RateLimitPolicy.onSharedFailure). When the shared store cannot count
 * (database unavailable, timeout, table missing or incompatible, breaker open):
 *   - "deny" policies (model calls, uploads, Creator jobs) refuse with scope "unavailable" (HTTP 503 + Retry-After);
 *   - "scaled-local" policies use a per-process window of floor(max / RATE_LIMIT_MAX_INSTANCES), scope
 *     "local-degraded", so the fleet-wide bound still holds for up to that many instances.
 * A per-process counter is never reported as the global quota. Failures are bounded: each attempt has a timeout,
 * deadlocks are retried once, and after 3 consecutive failures the store is skipped for a cooldown (no DB calls).
 * This is availability/abuse control only; spend is authorised elsewhere (gateway budget, Creator ledger) and those
 * fail closed independently of this limiter.
 *
 * The application never creates or alters the table: it is installed by migration 0013 through the guarded migrate
 * workflow. The limiter checks the table shape on first use and periodically after a failure.
 */
type Db = ReturnType<typeof drizzle>;
export type RateLimitDbProvider = () => Promise<Db | null | undefined>;

export type SharedLimiterState = "unchecked" | "shared" | "degraded" | "missing" | "incompatible";
export type RateLimiterStatus =
  | { store: "memory"; state: "local"; note: string }
  | {
      store: "mysql";
      state: SharedLimiterState;
      breaker: "closed" | "open";
      consecutiveFailures: number;
      lastFailureClass: "unavailable" | "timeout" | "missing" | "incompatible" | "error" | null;
      instanceCeiling: number;
      counts: { shared: number; degradedAllowed: number; degradedDenied: number; deniedUnavailable: number; retries: number };
    };

export interface RateLimiter {
  consume(key: string, policy: RateLimitPolicy, now?: number): Promise<RateLimitDecision>;
  status(): RateLimiterStatus;
  /** Readiness: confirm the shared table exists with the expected shape (no counting, bounded). No-op per process. */
  verify(now?: number): Promise<RateLimiterStatus>;
}

export type SharedLimiterOptions = {
  instanceCeiling?: number;
  timeoutMs?: number;
  failureThreshold?: number;
  cooldownMs?: number;
  schemaRecheckMs?: number;
  onFailure?: (failureClass: string, error: unknown) => void;
};

const MAX_BUCKET_KEY = 191;
const PRUNE_INTERVAL_MS = 60_000;
const RETRYABLE_ERRNO = new Set([1213 /* ER_LOCK_DEADLOCK */, 1205 /* ER_LOCK_WAIT_TIMEOUT */]);

const rowsOf = <T>(result: unknown): T[] => (Array.isArray(result) && Array.isArray(result[0]) ? (result[0] as T[]) : []);

class LimiterFailure extends Error {
  constructor(readonly failureClass: "unavailable" | "timeout" | "missing" | "incompatible" | "error", message: string) {
    super(message);
  }
}

function validate(key: string, policy: RateLimitPolicy) {
  if (!key) throw new Error("rate-limit key is required");
  if (!Number.isInteger(policy.maxRequests) || policy.maxRequests < 1) throw new Error("maxRequests must be a positive integer");
  if (!Number.isInteger(policy.windowMs) || policy.windowMs < 1) throw new Error("windowMs must be a positive integer");
  const bucketKey = `${policy.name}:${key}`;
  if (bucketKey.length > MAX_BUCKET_KEY) throw new Error("rate-limit key is too long");
  return bucketKey;
}

const errnoOf = (error: unknown): number | undefined =>
  (error as { errno?: number })?.errno ?? (error as { cause?: { errno?: number } })?.cause?.errno;
const codeOf = (error: unknown): string | undefined =>
  (error as { code?: string })?.code ?? (error as { cause?: { code?: string } })?.cause?.code;

function classify(error: unknown): LimiterFailure {
  if (error instanceof LimiterFailure) return error;
  const errno = errnoOf(error);
  const code = codeOf(error);
  if (errno === 1146 || code === "ER_NO_SUCH_TABLE") return new LimiterFailure("missing", "rateLimitWindows does not exist");
  if (errno === 1054 || code === "ER_BAD_FIELD_ERROR") return new LimiterFailure("incompatible", "rateLimitWindows has an unexpected shape");
  return new LimiterFailure("error", error instanceof Error ? error.message : String(error));
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new LimiterFailure("timeout", `shared limiter exceeded ${ms} ms`)), ms); })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Columns the limiter relies on. Wider types are accepted; anything else is incompatible (fail per policy). */
export function checkRateLimitTableShape(rows: Array<{ c: string; type: string; len: number | null; key: string }>): "ok" | "missing" | "incompatible" {
  if (!rows.length) return "missing";
  const col = new Map(rows.map(r => [r.c, r]));
  const bucket = col.get("bucketKey");
  const ok =
    !!bucket && ["varchar", "char"].includes(bucket.type) && Number(bucket.len) >= MAX_BUCKET_KEY && bucket.key === "PRI" &&
    col.get("windowStart")?.type === "bigint" &&
    ["int", "bigint"].includes(col.get("count")?.type ?? "") &&
    col.get("expiresAt")?.type === "bigint";
  return ok ? "ok" : "incompatible";
}

export class MysqlRateLimiter implements RateLimiter {
  private readonly local = new InMemoryRateLimiter();
  private readonly instanceCeiling: number;
  private readonly timeoutMs: number;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly schemaRecheckMs: number;
  private schema: "unchecked" | "ok" | "missing" | "incompatible" = "unchecked";
  private schemaCheckedAt = 0;
  private consecutiveFailures = 0;
  private breakerOpenUntil = 0;
  private lastFailureClass: LimiterFailure["failureClass"] | null = null;
  private lastPrune = 0;
  /** Time of the latest decision (decisions may carry an injected clock); status() reports relative to it. */
  private lastSeen: number | null = null;
  private readonly counts = { shared: 0, degradedAllowed: 0, degradedDenied: 0, deniedUnavailable: 0, retries: 0 };

  constructor(private readonly getDb: RateLimitDbProvider, private readonly options: SharedLimiterOptions = {}) {
    this.instanceCeiling = options.instanceCeiling ?? 2;
    this.timeoutMs = options.timeoutMs ?? 1_000;
    this.failureThreshold = options.failureThreshold ?? 3;
    this.cooldownMs = options.cooldownMs ?? 15_000;
    this.schemaRecheckMs = options.schemaRecheckMs ?? 60_000;
    if (!Number.isInteger(this.instanceCeiling) || this.instanceCeiling < 1) throw new Error("instanceCeiling must be a positive integer");
  }

  status(): RateLimiterStatus {
    const now = this.lastSeen ?? Date.now();
    const breakerOpen = now < this.breakerOpenUntil;
    const state: SharedLimiterState =
      this.schema === "missing" || this.schema === "incompatible" ? this.schema
      : this.schema === "unchecked" && this.counts.shared === 0 && this.consecutiveFailures === 0 ? "unchecked"
      : breakerOpen || this.consecutiveFailures > 0 ? "degraded"
      : "shared";
    return {
      store: "mysql", state, breaker: breakerOpen ? "open" : "closed", consecutiveFailures: this.consecutiveFailures,
      lastFailureClass: this.lastFailureClass, instanceCeiling: this.instanceCeiling, counts: { ...this.counts },
    };
  }

  async consume(key: string, policy: RateLimitPolicy, now = Date.now()): Promise<RateLimitDecision> {
    const bucketKey = validate(key, policy);
    const windowStart = Math.floor(now / policy.windowMs) * policy.windowMs;
    const resetAt = windowStart + policy.windowMs;
    this.lastSeen = now;

    if (now >= this.breakerOpenUntil) {
      try {
        const count = await withTimeout(this.countShared(bucketKey, windowStart, resetAt, now), this.timeoutMs);
        this.consecutiveFailures = 0;
        this.counts.shared += 1;
        const allowed = count <= policy.maxRequests;
        return { allowed, limit: policy.maxRequests, remaining: Math.max(0, policy.maxRequests - count), resetAt, retryAfterMs: allowed ? 0 : Math.max(1, resetAt - now), scope: "global" };
      } catch (error) {
        const failure = classify(error);
        this.lastFailureClass = failure.failureClass;
        if (failure.failureClass === "missing" || failure.failureClass === "incompatible") { this.schema = failure.failureClass; this.schemaCheckedAt = now; }
        this.consecutiveFailures += 1;
        if (this.consecutiveFailures >= this.failureThreshold) this.breakerOpenUntil = now + this.cooldownMs;
        try { this.options.onFailure?.(failure.failureClass, error); } catch { /* logging never changes a decision */ }
      }
    }
    return this.decideWithoutSharedStore(key, policy, now);
  }

  private decideWithoutSharedStore(key: string, policy: RateLimitPolicy, now: number): RateLimitDecision {
    const retryAfterMs = Math.max(1_000, this.breakerOpenUntil - now);
    if ((policy.onSharedFailure ?? "scaled-local") === "deny") {
      this.counts.deniedUnavailable += 1;
      return { allowed: false, limit: policy.maxRequests, remaining: 0, resetAt: now + retryAfterMs, retryAfterMs, scope: "unavailable" };
    }
    const scaled: RateLimitPolicy = { name: `${policy.name}:degraded`, maxRequests: Math.max(1, Math.floor(policy.maxRequests / this.instanceCeiling)), windowMs: policy.windowMs };
    const decision = this.local.consume(key, scaled, now);
    if (decision.allowed) this.counts.degradedAllowed += 1; else this.counts.degradedDenied += 1;
    return { ...decision, scope: "local-degraded" };
  }

  private async countShared(bucketKey: string, windowStart: number, resetAt: number, now: number): Promise<number> {
    const db = await this.getDb();
    if (!db) throw new LimiterFailure("unavailable", "database unavailable");
    if (this.schema !== "ok" && now - this.schemaCheckedAt >= (this.schema === "unchecked" ? 0 : this.schemaRecheckMs)) {
      await this.checkSchema(db, now);
    }
    if (this.schema === "missing" || this.schema === "incompatible") throw new LimiterFailure(this.schema, `rateLimitWindows is ${this.schema}`);
    for (let attempt = 1; ; attempt++) {
      try {
        const count = await db.transaction(async tx => {
          // Same or newer stored window: count it. Older stored window: restart at 1. Never move a window backwards.
          await tx.execute(sql`
            INSERT INTO rateLimitWindows (bucketKey, windowStart, count, expiresAt) VALUES (${bucketKey}, ${windowStart}, 1, ${resetAt})
            ON DUPLICATE KEY UPDATE
              count = IF(windowStart >= ${windowStart}, count + 1, 1),
              expiresAt = IF(windowStart >= ${windowStart}, expiresAt, ${resetAt}),
              windowStart = GREATEST(windowStart, ${windowStart})`);
          const rows = rowsOf<{ count: number | string }>(await tx.execute(sql`SELECT count FROM rateLimitWindows WHERE bucketKey = ${bucketKey}`));
          const value = Number(rows[0]?.count);
          if (!Number.isInteger(value) || value < 1) throw new LimiterFailure("error", "rate-limit counter unreadable");
          return value;
        });
        void this.prune(db, now);
        return count;
      } catch (error) {
        const errno = errnoOf(error);
        if (attempt === 1 && errno !== undefined && RETRYABLE_ERRNO.has(errno)) { this.counts.retries += 1; continue; }
        throw error;
      }
    }
  }

  private async checkSchema(db: Db, now: number) {
    const rows = rowsOf<{ c: string; type: string; len: number | null; key: string }>(await db.execute(sql`
      SELECT COLUMN_NAME c, DATA_TYPE type, CHARACTER_MAXIMUM_LENGTH len, COLUMN_KEY \`key\`
      FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'rateLimitWindows'`));
    this.schema = checkRateLimitTableShape(rows.map(r => ({ ...r, type: String(r.type).toLowerCase(), len: r.len === null ? null : Number(r.len) })));
    this.schemaCheckedAt = now;
  }

  async verify(now = Date.now()): Promise<RateLimiterStatus> {
    this.lastSeen = now;
    if (this.schema === "ok" && now - this.schemaCheckedAt < this.schemaRecheckMs && this.consecutiveFailures === 0 && now >= this.breakerOpenUntil) return this.status();
    try {
      const db = await withTimeout(this.getDb(), this.timeoutMs);
      if (db) {
        await withTimeout(this.checkSchema(db, now), this.timeoutMs);
        if (this.schema === "ok") {
          // A successful bounded readiness probe is explicit recovery evidence: clear stale
          // outage/breaker state only after the shared table is reachable and shape-valid.
          this.consecutiveFailures = 0;
          this.lastFailureClass = null;
          this.breakerOpenUntil = 0;
        }
      }
    } catch { /* an unreachable database is reported by this limiter as non-shared and by the database readiness probe */ }
    return this.status();
  }

  /** Bounded, best-effort cleanup of expired windows; at most once a minute per process. Never affects a decision. */
  private async prune(db: Db, now: number) {
    if (now - this.lastPrune < PRUNE_INTERVAL_MS) return;
    this.lastPrune = now;
    try { await db.execute(sql`DELETE FROM rateLimitWindows WHERE expiresAt < ${now} LIMIT 500`); } catch { /* next interval retries */ }
  }
}

/** Per-process limiter behind the async interface (default; RATE_LIMIT_STORE unset or "memory"). */
export class ProcessRateLimiter implements RateLimiter {
  constructor(private readonly inner: InMemoryRateLimiter = new InMemoryRateLimiter()) {}
  async consume(key: string, policy: RateLimitPolicy, now = Date.now()): Promise<RateLimitDecision> {
    return { ...this.inner.consume(key, policy, now), scope: "local" };
  }
  status(): RateLimiterStatus {
    return { store: "memory", state: "local", note: "per-process counters: correct only for a single instance" };
  }
  async verify(): Promise<RateLimiterStatus> {
    return this.status();
  }
}

export type RateLimitStoreChoice = { store: "memory" | "mysql"; instanceCeiling: number; timeoutMs: number; warnings: string[] };

const boundedInt = (raw: string | undefined, fallback: number, min: number, max: number, name: string, warnings: string[]) => {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (Number.isInteger(n) && n >= min && n <= max) return n;
  warnings.push(`${name}=${raw} is outside ${min}..${max}; using ${fallback}`);
  return fallback;
};

/** Unknown values, or mysql without DATABASE_URL, fall back to the per-process store with a warning: a limiter always exists. */
export function rateLimitStoreFromEnv(env: Record<string, string | undefined>): RateLimitStoreChoice {
  const warnings: string[] = [];
  const instanceCeiling = boundedInt(env.RATE_LIMIT_MAX_INSTANCES, 2, 1, 64, "RATE_LIMIT_MAX_INSTANCES", warnings);
  const timeoutMs = boundedInt(env.RATE_LIMIT_DB_TIMEOUT_MS, 1_000, 100, 10_000, "RATE_LIMIT_DB_TIMEOUT_MS", warnings);
  const raw = env.RATE_LIMIT_STORE?.trim().toLowerCase();
  if (!raw || raw === "memory") return { store: "memory", instanceCeiling, timeoutMs, warnings };
  if (raw === "mysql") {
    if (!env.DATABASE_URL?.trim()) return { store: "memory", instanceCeiling, timeoutMs, warnings: [...warnings, "RATE_LIMIT_STORE=mysql needs DATABASE_URL; using the per-process limiter"] };
    return { store: "mysql", instanceCeiling, timeoutMs, warnings };
  }
  return { store: "memory", instanceCeiling, timeoutMs, warnings: [...warnings, `RATE_LIMIT_STORE=${raw} is not recognised (memory | mysql); using the per-process limiter`] };
}

export function createRateLimiter(env: Record<string, string | undefined>, getDb: RateLimitDbProvider, log: (message: string) => void = message => console.warn(message)): RateLimiter {
  const choice = rateLimitStoreFromEnv(env);
  for (const warning of choice.warnings) log(`[rate-limit] ${warning}`);
  if (choice.store === "memory") return new ProcessRateLimiter();
  let lastLogged = 0;
  return new MysqlRateLimiter(getDb, {
    instanceCeiling: choice.instanceCeiling,
    timeoutMs: choice.timeoutMs,
    onFailure: failureClass => {
      const at = Date.now();
      if (at - lastLogged < 60_000) return;
      lastLogged = at;
      // Class only: no SQL, hostnames or error text from the driver in logs.
      log(`[rate-limit] shared store failed (${failureClass}); costly routes refuse, others use scaled per-process limits`);
    },
  });
}

let authenticatedLimiter: RateLimiter | null = null;
/** Process-wide limiter for authenticated tRPC procedures. The database module is loaded lazily. */
export function getAuthenticatedRateLimiter(): RateLimiter {
  authenticatedLimiter ??= createRateLimiter(process.env, async () => (await import("../db")).getDb());
  return authenticatedLimiter;
}

/** Readiness: a configured shared store whose table is missing or has the wrong shape is a deployment error. */
export function rateLimitReadiness(status: RateLimiterStatus, options: { requireShared?: boolean } = {}): { store: string; state: string; ready: boolean } {
  if (status.store === "memory") return { store: "memory", state: "local", ready: options.requireShared !== true };
  // A configured MySQL limiter is deployment-ready only when the shared table is verified and the
  // store is currently healthy. unchecked/degraded states must not let /readyz overclaim a global quota.
  return { store: "mysql", state: status.state, ready: status.state === "shared" };
}
