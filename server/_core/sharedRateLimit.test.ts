import { describe, expect, it } from "vitest";
import { createRateLimiter, MysqlRateLimiter, ProcessRateLimiter, rateLimitStoreFromEnv } from "./sharedRateLimit";

const policy = { name: "t", maxRequests: 2, windowMs: 60_000 };

describe("rate-limit store selection", () => {
  it("defaults to the per-process limiter and never fails to build one", () => {
    expect(rateLimitStoreFromEnv({})).toEqual({ store: "memory" });
    expect(rateLimitStoreFromEnv({ RATE_LIMIT_STORE: "memory" })).toEqual({ store: "memory" });
    expect(rateLimitStoreFromEnv({ RATE_LIMIT_STORE: "mysql", DATABASE_URL: "mysql://u:p@127.0.0.1/db" })).toEqual({ store: "mysql" });
    expect(rateLimitStoreFromEnv({ RATE_LIMIT_STORE: "mysql" })).toMatchObject({ store: "memory", warning: expect.stringContaining("DATABASE_URL") });
    expect(rateLimitStoreFromEnv({ RATE_LIMIT_STORE: "redis" })).toMatchObject({ store: "memory", warning: expect.stringContaining("not recognised") });
    const logs: string[] = [];
    expect(createRateLimiter({ RATE_LIMIT_STORE: "bogus" }, async () => null, m => logs.push(m))).toBeInstanceOf(ProcessRateLimiter);
    expect(logs).toHaveLength(1);
    expect(createRateLimiter({ RATE_LIMIT_STORE: "mysql", DATABASE_URL: "mysql://x/y" }, async () => null, () => undefined)).toBeInstanceOf(MysqlRateLimiter);
  });
});

describe("shared limiter failure policy", () => {
  it("an unavailable or failing store degrades to the per-process limit (still enforced), and is counted", async () => {
    for (const getDb of [async () => null, async () => { throw new Error("connect ECONNREFUSED"); }, async () => ({ transaction: async () => { throw new Error("Table 'rateLimitWindows' doesn't exist"); } }) as never]) {
      const errors: unknown[] = [];
      const limiter = new MysqlRateLimiter(getDb as never, undefined, e => errors.push(e));
      const decisions = [await limiter.consume("user:1", policy, 1_000), await limiter.consume("user:1", policy, 1_001), await limiter.consume("user:1", policy, 1_002)];
      expect(decisions.map(d => d.allowed)).toEqual([true, true, false]);
      expect(decisions[2]!.retryAfterMs).toBeGreaterThan(0);
      expect(limiter.status()).toEqual({ shared: 0, fallback: 3 });
      expect(errors).toHaveLength(3);
    }
  });

  it("rejects invalid input before touching any store", async () => {
    const limiter = new MysqlRateLimiter(async () => { throw new Error("must not be called"); });
    await expect(limiter.consume("", policy)).rejects.toThrow(/key is required/);
    await expect(limiter.consume("k", { ...policy, maxRequests: 0 })).rejects.toThrow(/positive integer/);
    await expect(limiter.consume("k", { ...policy, windowMs: 1.5 })).rejects.toThrow(/positive integer/);
    await expect(limiter.consume("x".repeat(200), policy)).rejects.toThrow(/too long/);
  });
});
