import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RateLimitDecision } from "./rateLimit";

const next: { decision: RateLimitDecision } = { decision: { allowed: true, limit: 1, remaining: 0, resetAt: 0, retryAfterMs: 0, scope: "global" } };
vi.mock("./sharedRateLimit", () => ({
  getAuthenticatedRateLimiter: () => ({ consume: async () => next.decision, status: () => ({ store: "mysql" }), verify: async () => ({ store: "mysql" }) }),
}));

const { router, protectedProcedure } = await import("./trpc");
const app = router({ ping: protectedProcedure.query(() => "pong") });

function call() {
  const headers: Record<string, string> = {};
  const res = { headersSent: false, setHeader: (k: string, v: string) => { headers[k] = v; } };
  const caller = app.createCaller({ user: { id: 7, role: "user" }, req: {}, res } as never);
  return { headers, run: () => caller.ping() };
}

describe("authenticated rate-limit middleware", () => {
  beforeEach(() => { next.decision = { allowed: true, limit: 5, remaining: 4, resetAt: 60_000, retryAfterMs: 0, scope: "global" }; });

  it("reports which counter decided", async () => {
    const c = call();
    await expect(c.run()).resolves.toBe("pong");
    expect(c.headers["X-RateLimit-Scope"]).toBe("global");
  });

  it("an exhausted quota is 429 with Retry-After", async () => {
    next.decision = { allowed: false, limit: 5, remaining: 0, resetAt: 60_000, retryAfterMs: 12_000, scope: "global" };
    const c = call();
    await expect(c.run()).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(c.headers["Retry-After"]).toBe("12");
  });

  it("an unavailable shared counter is 503, never presented as a quota verdict", async () => {
    next.decision = { allowed: false, limit: 5, remaining: 0, resetAt: 15_000, retryAfterMs: 15_000, scope: "unavailable" };
    const c = call();
    await expect(c.run()).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    expect(c.headers["X-RateLimit-Scope"]).toBe("unavailable");
    expect(c.headers["Retry-After"]).toBe("15");
  });

  it("degraded local counting is labelled as such", async () => {
    next.decision = { allowed: true, limit: 2, remaining: 1, resetAt: 60_000, retryAfterMs: 0, scope: "local-degraded" };
    const c = call();
    await expect(c.run()).resolves.toBe("pong");
    expect(c.headers["X-RateLimit-Scope"]).toBe("local-degraded");
  });
});
