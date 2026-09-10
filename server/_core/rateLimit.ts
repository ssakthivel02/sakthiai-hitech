export type RateLimitPolicy = {
  name: string;
  maxRequests: number;
  windowMs: number;
};

export type RateLimitDecision = {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfterMs: number;
};

type Bucket = {
  count: number;
  resetAt: number;
};

export const AUTHENTICATED_RATE_POLICIES = {
  default: {
    name: "authenticated-default",
    maxRequests: 180,
    windowMs: 60_000,
  },
  chatSend: {
    name: "chat-send",
    maxRequests: 20,
    windowMs: 60_000,
  },
  fileUpload: {
    name: "file-upload",
    maxRequests: 12,
    windowMs: 60_000,
  },
} as const satisfies Record<string, RateLimitPolicy>;

export function selectAuthenticatedRatePolicy(path: string): RateLimitPolicy {
  if (path === "chat.send") return AUTHENTICATED_RATE_POLICIES.chatSend;
  if (path === "files.upload") return AUTHENTICATED_RATE_POLICIES.fileUpload;
  return AUTHENTICATED_RATE_POLICIES.default;
}

/**
 * Per-process fixed-window limiter used as a first-line authenticated abuse guard.
 *
 * This is intentionally dependency-free and bounded in memory. It is not a
 * replacement for a distributed quota service when SakthiAI runs more than one
 * application instance. Distributed/global quota enforcement remains a runtime
 * architecture requirement before high-scale production claims.
 */
export class InMemoryRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly maxKeys = 10_000) {
    if (!Number.isInteger(maxKeys) || maxKeys < 1) {
      throw new Error("maxKeys must be a positive integer");
    }
  }

  consume(key: string, policy: RateLimitPolicy, now = Date.now()): RateLimitDecision {
    if (!key) throw new Error("rate-limit key is required");
    if (!Number.isInteger(policy.maxRequests) || policy.maxRequests < 1) {
      throw new Error("maxRequests must be a positive integer");
    }
    if (!Number.isFinite(policy.windowMs) || policy.windowMs < 1) {
      throw new Error("windowMs must be positive");
    }

    const bucketKey = `${policy.name}:${key}`;
    let bucket = this.buckets.get(bucketKey);

    if (!bucket || now >= bucket.resetAt) {
      this.pruneExpired(now);
      this.ensureCapacity(bucketKey);
      bucket = { count: 0, resetAt: now + policy.windowMs };
      this.buckets.set(bucketKey, bucket);
    }

    if (bucket.count >= policy.maxRequests) {
      return {
        allowed: false,
        limit: policy.maxRequests,
        remaining: 0,
        resetAt: bucket.resetAt,
        retryAfterMs: Math.max(1, bucket.resetAt - now),
      };
    }

    bucket.count += 1;
    return {
      allowed: true,
      limit: policy.maxRequests,
      remaining: Math.max(0, policy.maxRequests - bucket.count),
      resetAt: bucket.resetAt,
      retryAfterMs: 0,
    };
  }

  size(): number {
    return this.buckets.size;
  }

  clear(): void {
    this.buckets.clear();
  }

  private pruneExpired(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (now >= bucket.resetAt) this.buckets.delete(key);
    }
  }

  private ensureCapacity(incomingKey: string): void {
    if (this.buckets.has(incomingKey) || this.buckets.size < this.maxKeys) return;

    const oldestKey = this.buckets.keys().next().value as string | undefined;
    if (oldestKey) this.buckets.delete(oldestKey);
  }
}
