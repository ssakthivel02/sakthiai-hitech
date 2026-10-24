import { sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/mysql2";
import { InMemoryRateLimiter, type RateLimitDecision, type RateLimitPolicy } from "./rateLimit";

/**
 * Rate limiting shared by every server instance (RATE_LIMIT_STORE=mysql).
 *
 * The in-process limiter bounds each instance separately, so N instances allow N x the policy. This store keeps one
 * fixed-window counter per (policy, user) in MySQL, aligned to windowMs boundaries, so all instances draw from the same
 * budget. One upsert plus a read of the same row inside one transaction: InnoDB row locking serialises concurrent
 * requests, so exactly `maxRequests` are admitted per window across the fleet.
 *
 * Failure policy: this is an abuse guard, not a spend control (spend is enforced by the gateway budget and the Creator
 * ledger, which fail closed). If the shared store is unavailable the request is decided by the per-process limiter,
 * so a database outage degrades to today's behaviour instead of locking every user out. Fallbacks are counted.
 */
type Db = ReturnType<typeof drizzle>;
export type RateLimitDbProvider = () => Promise<Db | null | undefined>;

export interface RateLimiter {
  consume(key: string, policy: RateLimitPolicy, now?: number): Promise<RateLimitDecision>;
}

const MAX_BUCKET_KEY = 191;
const PRUNE_INTERVAL_MS = 60_000;

const rowsOf = <T>(result: unknown): T[] => (Array.isArray(result) && Array.isArray(result[0]) ? (result[0] as T[]) : []);

function validate(key: string, policy: RateLimitPolicy) {
  if (!key) throw new Error("rate-limit key is required");
  if (!Number.isInteger(policy.maxRequests) || policy.maxRequests < 1) throw new Error("maxRequests must be a positive integer");
  if (!Number.isInteger(policy.windowMs) || policy.windowMs < 1) throw new Error("windowMs must be a positive integer");
  const bucketKey = `${policy.name}:${key}`;
  if (bucketKey.length > MAX_BUCKET_KEY) throw new Error("rate-limit key is too long");
  return bucketKey;
}

export class MysqlRateLimiter implements RateLimiter {
  private lastPrune = 0;
  private readonly stats = { shared: 0, fallback: 0 };

  constructor(
    private readonly getDb: RateLimitDbProvider,
    private readonly fallback: InMemoryRateLimiter = new InMemoryRateLimiter(),
    private readonly onFallback: (error: unknown) => void = () => undefined,
  ) {}

  status() {
    return { ...this.stats };
  }

  async consume(key: string, policy: RateLimitPolicy, now = Date.now()): Promise<RateLimitDecision> {
    const bucketKey = validate(key, policy);
    const windowStart = Math.floor(now / policy.windowMs) * policy.windowMs;
    const resetAt = windowStart + policy.windowMs;
    try {
      const db = await this.getDb();
      if (!db) throw new Error("database unavailable");
      const count = await db.transaction(async tx => {
        // Same window: increment. Older window: restart at 1. A row from a FUTURE window (clock skew between instances)
        // is kept and counted, never reset backwards.
        await tx.execute(sql`
          INSERT INTO rateLimitWindows (bucketKey, windowStart, count, expiresAt) VALUES (${bucketKey}, ${windowStart}, 1, ${resetAt})
          ON DUPLICATE KEY UPDATE
            count = IF(windowStart >= ${windowStart}, count + 1, 1),
            expiresAt = IF(windowStart >= ${windowStart}, expiresAt, ${resetAt}),
            windowStart = GREATEST(windowStart, ${windowStart})`);
        const rows = rowsOf<{ count: number | string }>(await tx.execute(sql`SELECT count FROM rateLimitWindows WHERE bucketKey = ${bucketKey}`));
        const value = Number(rows[0]?.count);
        if (!Number.isInteger(value) || value < 1) throw new Error("rate-limit counter unreadable");
        return value;
      });
      this.stats.shared += 1;
      void this.prune(db, now);
      const allowed = count <= policy.maxRequests;
      return {
        allowed,
        limit: policy.maxRequests,
        remaining: Math.max(0, policy.maxRequests - count),
        resetAt,
        retryAfterMs: allowed ? 0 : Math.max(1, resetAt - now),
      };
    } catch (error) {
      this.stats.fallback += 1;
      try { this.onFallback(error); } catch { /* logging must never change the decision */ }
      return this.fallback.consume(key, policy, now);
    }
  }

  /** Bounded, best-effort cleanup of expired windows; at most once a minute per process. Never affects a decision. */
  private async prune(db: Db, now: number) {
    if (now - this.lastPrune < PRUNE_INTERVAL_MS) return;
    this.lastPrune = now;
    try { await db.execute(sql`DELETE FROM rateLimitWindows WHERE expiresAt < ${now} LIMIT 500`); } catch { /* next interval retries */ }
  }
}

/** In-process limiter behind the async interface (default; RATE_LIMIT_STORE unset or "memory"). */
export class ProcessRateLimiter implements RateLimiter {
  constructor(private readonly inner: InMemoryRateLimiter = new InMemoryRateLimiter()) {}
  async consume(key: string, policy: RateLimitPolicy, now = Date.now()) {
    return this.inner.consume(key, policy, now);
  }
}

export type RateLimitStoreChoice = { store: "memory" | "mysql"; warning?: string };

/** Unknown values fall back to "memory" with a warning: the limiter must always exist. */
export function rateLimitStoreFromEnv(env: Record<string, string | undefined>): RateLimitStoreChoice {
  const raw = env.RATE_LIMIT_STORE?.trim().toLowerCase();
  if (!raw || raw === "memory") return { store: "memory" };
  if (raw === "mysql") {
    if (!env.DATABASE_URL?.trim()) return { store: "memory", warning: "RATE_LIMIT_STORE=mysql needs DATABASE_URL; using the per-process limiter" };
    return { store: "mysql" };
  }
  return { store: "memory", warning: `RATE_LIMIT_STORE=${raw} is not recognised (memory | mysql); using the per-process limiter` };
}

export function createRateLimiter(env: Record<string, string | undefined>, getDb: RateLimitDbProvider, log: (message: string) => void = message => console.warn(message)): RateLimiter {
  const choice = rateLimitStoreFromEnv(env);
  if (choice.warning) log(`[rate-limit] ${choice.warning}`);
  if (choice.store === "memory") return new ProcessRateLimiter();
  let lastLogged = 0;
  return new MysqlRateLimiter(getDb, new InMemoryRateLimiter(), error => {
    const at = Date.now();
    if (at - lastLogged < 60_000) return;
    lastLogged = at;
    log(`[rate-limit] shared store unavailable, using the per-process limiter: ${error instanceof Error ? error.message : String(error)}`);
  });
}
