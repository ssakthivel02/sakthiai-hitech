import { describe, expect, it } from "vitest";
import {
  AUTHENTICATED_RATE_POLICIES,
  InMemoryRateLimiter,
  selectAuthenticatedRatePolicy,
} from "./rateLimit";

describe("selectAuthenticatedRatePolicy", () => {
  it("applies tighter budgets to expensive authenticated procedures", () => {
    expect(selectAuthenticatedRatePolicy("chat.send")).toEqual(
      AUTHENTICATED_RATE_POLICIES.chatSend,
    );
    expect(selectAuthenticatedRatePolicy("files.upload")).toEqual(
      AUTHENTICATED_RATE_POLICIES.fileUpload,
    );
    expect(selectAuthenticatedRatePolicy("workspace.list")).toEqual(
      AUTHENTICATED_RATE_POLICIES.default,
    );
  });
});

describe("InMemoryRateLimiter", () => {
  const policy = { name: "test", maxRequests: 2, windowMs: 1_000 };

  it("allows requests up to the budget then fails closed", () => {
    const limiter = new InMemoryRateLimiter();

    expect(limiter.consume("user:1", policy, 1_000)).toMatchObject({
      allowed: true,
      remaining: 1,
    });
    expect(limiter.consume("user:1", policy, 1_100)).toMatchObject({
      allowed: true,
      remaining: 0,
    });
    expect(limiter.consume("user:1", policy, 1_200)).toMatchObject({
      allowed: false,
      remaining: 0,
      retryAfterMs: 800,
    });
  });

  it("resets a budget after the fixed window", () => {
    const limiter = new InMemoryRateLimiter();

    limiter.consume("user:1", policy, 1_000);
    limiter.consume("user:1", policy, 1_100);
    expect(limiter.consume("user:1", policy, 2_000)).toMatchObject({
      allowed: true,
      remaining: 1,
      retryAfterMs: 0,
    });
  });

  it("isolates budgets by user and policy", () => {
    const limiter = new InMemoryRateLimiter();
    const otherPolicy = { name: "other", maxRequests: 1, windowMs: 1_000 };

    limiter.consume("user:1", policy, 1_000);
    limiter.consume("user:1", policy, 1_010);

    expect(limiter.consume("user:2", policy, 1_020).allowed).toBe(true);
    expect(limiter.consume("user:1", otherPolicy, 1_030).allowed).toBe(true);
  });

  it("bounds memory and evicts the oldest active key when capacity is full", () => {
    const limiter = new InMemoryRateLimiter(2);

    limiter.consume("user:1", policy, 1_000);
    limiter.consume("user:2", policy, 1_010);
    limiter.consume("user:3", policy, 1_020);

    expect(limiter.size()).toBe(2);
    expect(limiter.consume("user:1", policy, 1_030)).toMatchObject({
      allowed: true,
      remaining: 1,
    });
  });

  it("rejects invalid policy configuration", () => {
    const limiter = new InMemoryRateLimiter();

    expect(() =>
      limiter.consume("user:1", { name: "bad", maxRequests: 0, windowMs: 1_000 }),
    ).toThrow("maxRequests must be a positive integer");
    expect(() =>
      limiter.consume("user:1", { name: "bad", maxRequests: 1, windowMs: 0 }),
    ).toThrow("windowMs must be positive");
  });
});
