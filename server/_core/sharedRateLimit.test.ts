import { describe, expect, it } from "vitest";
import { AUTHENTICATED_RATE_POLICIES } from "./rateLimit";
import { checkRateLimitTableShape, createRateLimiter, MysqlRateLimiter, ProcessRateLimiter, rateLimitReadiness, rateLimitStoreFromEnv } from "./sharedRateLimit";

const costly = { name: "chat-send", maxRequests: 4, windowMs: 60_000, onSharedFailure: "deny" as const };
const general = { name: "authenticated-default", maxRequests: 10, windowMs: 60_000, onSharedFailure: "scaled-local" as const };
const GOOD_SHAPE = [
  { c: "bucketKey", type: "varchar", len: 191, key: "PRI" },
  { c: "windowStart", type: "bigint", len: null, key: "" },
  { c: "count", type: "int", len: null, key: "" },
  { c: "expiresAt", type: "bigint", len: null, key: "MUL" },
];

/** In-memory stand-in for the drizzle handle: schema query + upsert/select on one shared map. Proves logic, not SQL. */
function fakeDb(opts: { shape?: typeof GOOD_SHAPE; failTx?: () => unknown; hangTx?: boolean } = {}) {
  const rows = new Map<string, { windowStart: number; count: number }>();
  let calls = 0;
  const text = (q: any) => JSON.stringify(q?.queryChunks ?? q);
  const exec = async (q: any) => {
    const t = text(q);
    if (t.includes("information_schema")) return [opts.shape ?? GOOD_SHAPE];
    if (t.includes("DELETE FROM rateLimitWindows")) return [{ affectedRows: 0 }];
    throw new Error("unexpected query");
  };
  return {
    rows, get calls() { return calls; },
    execute: exec,
    transaction: async (fn: (tx: any) => Promise<number>) => {
      calls += 1;
      if (opts.hangTx) return new Promise<number>(() => undefined);
      const failure = opts.failTx?.();
      if (failure) throw failure;
      let key = ""; let windowStart = 0;
      const tx = {
        execute: async (q: any) => {
          const params = (q?.queryChunks ?? []).filter((c: any) => typeof c !== "object" || c === null || !("value" in c));
          const t = text(q);
          if (t.includes("INSERT INTO rateLimitWindows")) {
            key = params[0]; windowStart = params[1];
            const r = rows.get(key);
            if (!r) rows.set(key, { windowStart, count: 1 });
            else if (r.windowStart >= windowStart) r.count += 1;
            else rows.set(key, { windowStart, count: 1 });
            return [{ affectedRows: 1 }];
          }
          if (t.includes("SELECT count")) return [[{ count: rows.get(key)!.count }]];
          throw new Error("unexpected tx query");
        },
      };
      return fn(tx);
    },
  };
}

describe("store selection", () => {
  it("defaults to per-process; mysql needs DATABASE_URL; bad values warn and fall back", () => {
    expect(rateLimitStoreFromEnv({})).toMatchObject({ store: "memory", instanceCeiling: 2, timeoutMs: 1000, warnings: [] });
    expect(rateLimitStoreFromEnv({ RATE_LIMIT_STORE: "mysql", DATABASE_URL: "mysql://u:p@127.0.0.1/db" })).toMatchObject({ store: "mysql" });
    expect(rateLimitStoreFromEnv({ RATE_LIMIT_STORE: "mysql" }).warnings.join()).toMatch(/DATABASE_URL/);
    expect(rateLimitStoreFromEnv({ RATE_LIMIT_STORE: "redis" })).toMatchObject({ store: "memory" });
    expect(rateLimitStoreFromEnv({ RATE_LIMIT_MAX_INSTANCES: "0", RATE_LIMIT_DB_TIMEOUT_MS: "5" })).toMatchObject({ instanceCeiling: 2, timeoutMs: 1000 });
    expect(rateLimitStoreFromEnv({ RATE_LIMIT_MAX_INSTANCES: "4" }).instanceCeiling).toBe(4);
    const logs: string[] = [];
    expect(createRateLimiter({ RATE_LIMIT_STORE: "bogus" }, async () => null, m => logs.push(m))).toBeInstanceOf(ProcessRateLimiter);
    expect(logs).toHaveLength(1);
  });

  it("every costly route refuses on shared-store failure; the general route degrades", () => {
    for (const p of [AUTHENTICATED_RATE_POLICIES.chatSend, AUTHENTICATED_RATE_POLICIES.fileUpload, AUTHENTICATED_RATE_POLICIES.creatorSubmit, AUTHENTICATED_RATE_POLICIES.creatorProviderJob]) {
      expect(p.onSharedFailure, p.name).toBe("deny");
    }
    expect((AUTHENTICATED_RATE_POLICIES.default as { onSharedFailure?: string }).onSharedFailure ?? "scaled-local").toBe("scaled-local");
  });

  it("the per-process limiter labels itself local and is always ready", async () => {
    const l = new ProcessRateLimiter();
    expect((await l.consume("user:1", general)).scope).toBe("local");
    expect(rateLimitReadiness(await l.verify())).toEqual({ store: "memory", state: "local", ready: true });
  });
});

describe("shared limiter: counting and truthfulness", () => {
  it("counts globally and never reports a per-process counter as global", async () => {
    const db = fakeDb();
    const l = new MysqlRateLimiter(async () => db as never);
    const d = [];
    for (let i = 0; i < 5; i++) d.push(await l.consume("user:1", costly, 1_000 + i));
    expect(d.map(x => x.allowed)).toEqual([true, true, true, true, false]);
    expect(new Set(d.map(x => x.scope))).toEqual(new Set(["global"]));
    expect(l.status()).toMatchObject({ store: "mysql", state: "shared", breaker: "closed" });
  });

  it("a deadlock is retried once and still counted globally", async () => {
    let n = 0;
    const db = fakeDb({ failTx: () => (n++ === 0 ? Object.assign(new Error("Deadlock found"), { errno: 1213 }) : undefined) });
    const l = new MysqlRateLimiter(async () => db as never);
    expect(await l.consume("user:1", costly, 1_000)).toMatchObject({ allowed: true, scope: "global" });
    expect(l.status()).toMatchObject({ counts: { retries: 1, shared: 1 } });
  });
});

describe("shared limiter: explicit failure policy", () => {
  const unavailable = [
    ["no database", async () => null],
    ["connection error", async () => { throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }); }],
    ["missing table", async () => fakeDb({ shape: [] }) as never],
    ["incompatible table", async () => fakeDb({ shape: GOOD_SHAPE.map(r => (r.c === "windowStart" ? { ...r, type: "int" } : r)) }) as never],
    ["table dropped at runtime", async () => fakeDb({ failTx: () => Object.assign(new Error("Table doesn't exist"), { errno: 1146 }) }) as never],
  ] as const;

  it.each(unavailable)("%s: costly routes refuse (unavailable), general routes get the scaled local bound", async (_label, getDb) => {
    const l = new MysqlRateLimiter(getDb as never, { instanceCeiling: 2, failureThreshold: 100 });
    const c = await l.consume("user:1", costly, 1_000);
    expect(c).toMatchObject({ allowed: false, scope: "unavailable" });
    expect(c.retryAfterMs).toBeGreaterThan(0);
    const g = [];
    for (let i = 0; i < 7; i++) g.push(await l.consume("user:1", general, 1_000 + i));
    expect(g.filter(x => x.allowed)).toHaveLength(5); // floor(10 / 2)
    expect(g.every(x => x.scope === "local-degraded")).toBe(true);
    expect(g[0]!.limit).toBe(5);
    const s = l.status();
    expect(s.store === "mysql" && s.counts.shared).toBe(0);
  });

  it("shared-store readiness is true only when the MySQL limiter is healthy and verified", async () => {
    for (const [shape, state] of [[[], "missing"], [GOOD_SHAPE.map(r => (r.c === "bucketKey" ? { ...r, len: 64 } : r)), "incompatible"]] as const) {
      const l = new MysqlRateLimiter(async () => fakeDb({ shape: shape as never }) as never);
      expect(rateLimitReadiness(await l.verify())).toEqual({ store: "mysql", state, ready: false });
    }
    const down = new MysqlRateLimiter(async () => null);
    await down.consume("user:1", general, 1);
    expect(rateLimitReadiness(await down.verify())).toMatchObject({ ready: false, state: "degraded" });
    expect(rateLimitReadiness(await new MysqlRateLimiter(async () => null).verify())).toMatchObject({ ready: false, state: "unchecked" });
    expect(rateLimitReadiness(await new MysqlRateLimiter(async () => fakeDb() as never).verify())).toMatchObject({ ready: true, state: "shared" });
  });

  it("bounded failures: a hanging store times out, the breaker stops calling it, and it recovers after the cooldown", async () => {
    let healthy = false;
    const hanging = fakeDb({ hangTx: true });
    const good = fakeDb();
    let attempts = 0;
    const l = new MysqlRateLimiter(async () => { attempts += 1; return (healthy ? good : hanging) as never; }, { timeoutMs: 30, failureThreshold: 3, cooldownMs: 1_000 });
    const t0 = 10_000;
    const started = Date.now();
    for (let i = 0; i < 3; i++) expect((await l.consume("user:1", costly, t0 + i)).scope).toBe("unavailable");
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(l.status()).toMatchObject({ breaker: "open", consecutiveFailures: 3, lastFailureClass: "timeout" });
    const before = attempts;
    for (let i = 0; i < 20; i++) await l.consume("user:1", costly, t0 + 100 + i);
    expect(attempts).toBe(before); // no database calls while the breaker is open
    healthy = true;
    expect(await l.consume("user:1", costly, t0 + 2_000)).toMatchObject({ allowed: true, scope: "global" });
    expect(l.status()).toMatchObject({ state: "shared", consecutiveFailures: 0 });
  });

  it("rejects invalid input before touching any store", async () => {
    const l = new MysqlRateLimiter(async () => { throw new Error("must not be called"); });
    await expect(l.consume("", costly)).rejects.toThrow(/key is required/);
    await expect(l.consume("k", { ...costly, maxRequests: 0 })).rejects.toThrow(/positive integer/);
    await expect(l.consume("k", { ...costly, windowMs: 1.5 })).rejects.toThrow(/positive integer/);
    await expect(l.consume("x".repeat(200), costly)).rejects.toThrow(/too long/);
    expect(() => new MysqlRateLimiter(async () => null, { instanceCeiling: 0 })).toThrow(/instanceCeiling/);
  });
});

describe("table shape check", () => {
  it("accepts the 0013 shape and wider types; rejects anything that could break counting", () => {
    expect(checkRateLimitTableShape(GOOD_SHAPE)).toBe("ok");
    expect(checkRateLimitTableShape(GOOD_SHAPE.map(r => (r.c === "count" ? { ...r, type: "bigint" } : r)))).toBe("ok");
    expect(checkRateLimitTableShape([])).toBe("missing");
    expect(checkRateLimitTableShape(GOOD_SHAPE.filter(r => r.c !== "expiresAt"))).toBe("incompatible");
    expect(checkRateLimitTableShape(GOOD_SHAPE.map(r => (r.c === "bucketKey" ? { ...r, key: "" } : r)))).toBe("incompatible");
    expect(checkRateLimitTableShape(GOOD_SHAPE.map(r => (r.c === "windowStart" ? { ...r, type: "int" } : r)))).toBe("incompatible");
  });
});
