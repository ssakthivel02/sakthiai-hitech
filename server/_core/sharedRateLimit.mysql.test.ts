import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import mysql from "mysql2";
import { drizzle } from "drizzle-orm/mysql2";
import { sql } from "drizzle-orm";
import { createTestDatabase, skipMysqlSuite, type TestDatabase } from "../testing/mysqlTestDb";
import { MysqlRateLimiter, rateLimitReadiness, type SharedLimiterOptions } from "./sharedRateLimit";

/**
 * Real-SQL tests of the shared limiter (CI runs this file on MySQL 8.0 and on MySQL 8.4 containers).
 * Each "instance" owns its own connection pool, so concurrency goes through the database exactly as it does with
 * several server processes. The table comes from migration 0013, applied by createTestDatabase like every migration.
 */
describe.skipIf(skipMysqlSuite())("MySQL-shared authenticated rate limiter", () => {
  let database: TestDatabase;
  const pools: Array<ReturnType<typeof mysql.createPool>> = [];
  const pool = (connectionLimit = 8, port?: number) => {
    const url = new URL(database.url);
    const p = mysql.createPool({ host: url.hostname, port: port ?? Number(url.port), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database: database.name, connectionLimit, connectTimeout: 2_000 });
    pools.push(p);
    return drizzle(p);
  };
  const instance = (options: SharedLimiterOptions = {}, connectionLimit = 8) => {
    const db = pool(connectionLimit);
    return new MysqlRateLimiter(async () => db, { timeoutMs: 5_000, ...options });
  };
  const costly = { name: "chat-send", maxRequests: 5, windowMs: 60_000, onSharedFailure: "deny" as const };
  const general = { name: "authenticated-default", maxRequests: 10, windowMs: 60_000, onSharedFailure: "scaled-local" as const };
  const T0 = Date.UTC(2026, 9, 24, 12, 0, 0); // aligned to every window used here

  beforeAll(async () => { database = await createTestDatabase(); });
  afterAll(async () => { for (const p of pools) await p.promise().end().catch(() => undefined); await database?.close(); });
  beforeEach(async () => { await database.db.execute(sql`DELETE FROM rateLimitWindows`); });

  it("migration 0013 created the table the limiter checks for", async () => {
    expect(rateLimitReadiness(await instance().verify())).toEqual({ store: "mysql", state: "shared", ready: true });
  });

  it("independent instances share ONE budget under concurrency: no overshoot on either policy", async () => {
    const ls = [instance(), instance(), instance()];
    const results = await Promise.all([
      ...Array.from({ length: 60 }, (_, i) => ls[i % 3]!.consume("user:7", costly, T0 + i).then(r => ({ p: "costly", r }))),
      ...Array.from({ length: 60 }, (_, i) => ls[(i + 1) % 3]!.consume("user:7", general, T0 + i).then(r => ({ p: "general", r }))),
    ]);
    expect(results.filter(x => x.p === "costly" && x.r.allowed)).toHaveLength(5);
    expect(results.filter(x => x.p === "general" && x.r.allowed)).toHaveLength(10);
    expect(results.every(x => x.r.scope === "global")).toBe(true);
    for (const l of ls) expect(l.status()).toMatchObject({ state: "shared", consecutiveFailures: 0 });
  });

  it("heavy contention on one row through small pools: exact admission, no errors", async () => {
    const ls = [instance({}, 2), instance({}, 2), instance({}, 2), instance({}, 2)];
    const results = await Promise.all(Array.from({ length: 120 }, (_, i) => ls[i % 4]!.consume("user:hot", general, T0 + 5)));
    expect(results.filter(r => r.allowed)).toHaveLength(10);
    expect(results.every(r => r.scope === "global")).toBe(true);
  });

  it("window boundaries: the last millisecond belongs to the old window, the next starts fresh", async () => {
    const l = instance();
    for (let i = 0; i < 5; i++) expect((await l.consume("user:1", costly, T0 + i)).allowed).toBe(true);
    expect((await l.consume("user:1", costly, T0 + costly.windowMs - 1)).allowed).toBe(false);
    expect(await l.consume("user:1", costly, T0 + costly.windowMs)).toMatchObject({ allowed: true, remaining: 4, resetAt: T0 + 2 * costly.windowMs });
  });

  it("an instance whose clock is behind cannot reset or reuse a newer window", async () => {
    const ahead = instance(); const behind = instance();
    for (let i = 0; i < 5; i++) await ahead.consume("user:3", costly, T0 + costly.windowMs + i);
    for (let i = 0; i < 3; i++) expect((await behind.consume("user:3", costly, T0 + 5 + i)).allowed).toBe(false);
    expect((await ahead.consume("user:3", costly, T0 + costly.windowMs + 10)).allowed).toBe(false);
  });

  it("users and policies are isolated", async () => {
    const l = instance();
    for (let i = 0; i < 5; i++) await l.consume("user:1", costly, T0 + i);
    expect((await l.consume("user:1", costly, T0 + 9)).allowed).toBe(false);
    expect((await l.consume("user:2", costly, T0 + 9)).allowed).toBe(true);
    expect((await l.consume("user:1", general, T0 + 9)).allowed).toBe(true);
  });

  it("missing table: costly routes refuse, general routes degrade, readiness fails; recovery once the table is back", async () => {
    const l = instance({ schemaRecheckMs: 0, failureThreshold: 100 });
    expect((await l.consume("user:4", costly, T0)).scope).toBe("global");
    await database.db.execute(sql`RENAME TABLE rateLimitWindows TO rateLimitWindows_parked`);
    try {
      expect(await l.consume("user:4", costly, T0 + 1)).toMatchObject({ allowed: false, scope: "unavailable" });
      const g = await l.consume("user:4", general, T0 + 2);
      expect(g).toMatchObject({ allowed: true, scope: "local-degraded", limit: 5 });
      expect(rateLimitReadiness(await l.verify(T0 + 3))).toMatchObject({ state: "missing", ready: false });
    } finally {
      await database.db.execute(sql`RENAME TABLE rateLimitWindows_parked TO rateLimitWindows`);
    }
    expect(rateLimitReadiness(await l.verify(T0 + 4))).toMatchObject({ ready: true });
    expect(await l.consume("user:4", costly, T0 + 5)).toMatchObject({ allowed: true, scope: "global", remaining: 3 });
  });

  it("incompatible table shape is detected without counting, and readiness fails", async () => {
    await database.db.execute(sql`ALTER TABLE rateLimitWindows MODIFY windowStart int NOT NULL`);
    try {
      const l = instance({ failureThreshold: 100 });
      expect(rateLimitReadiness(await l.verify(T0))).toMatchObject({ state: "incompatible", ready: false });
      expect((await l.consume("user:5", costly, T0)).scope).toBe("unavailable");
      const [rows] = (await database.db.execute(sql`SELECT COUNT(*) n FROM rateLimitWindows`)) as unknown as [Array<{ n: number }>];
      expect(Number(rows[0]!.n)).toBe(0);
    } finally {
      await database.db.execute(sql`ALTER TABLE rateLimitWindows MODIFY windowStart bigint NOT NULL`);
    }
  });

  it("database outage: bounded failures, breaker stops calls, policy applied; recovery restores global counting", async () => {
    const dead = pool(1, 1); // nothing listens on port 1
    const live = pool();
    let target: typeof dead = dead; let calls = 0;
    const l = new MysqlRateLimiter(async () => { calls += 1; return target; }, { timeoutMs: 3_000, failureThreshold: 2, cooldownMs: 10_000 });
    expect((await l.consume("user:6", costly, T0)).scope).toBe("unavailable");
    expect((await l.consume("user:6", general, T0 + 1)).scope).toBe("local-degraded");
    expect(l.status()).toMatchObject({ breaker: "open", consecutiveFailures: 2 });
    const before = calls;
    for (let i = 0; i < 10; i++) await l.consume("user:6", costly, T0 + 100 + i);
    expect(calls).toBe(before);
    target = live;
    expect(await l.consume("user:6", costly, T0 + 10_001)).toMatchObject({ allowed: true, scope: "global" });
    expect(l.status()).toMatchObject({ state: "shared", breaker: "closed" });
  });

  it("expired windows are pruned (bounded) without affecting decisions", async () => {
    const l = instance();
    for (let u = 0; u < 20; u++) await database.db.execute(sql`INSERT INTO rateLimitWindows (bucketKey, windowStart, count, expiresAt) VALUES (${`chat-send:user:old${u}`}, ${T0 - 600_000}, 3, ${T0 - 540_000})`);
    expect((await l.consume("user:9", costly, T0)).allowed).toBe(true);
    await new Promise(r => setTimeout(r, 300));
    const [rows] = (await database.db.execute(sql`SELECT COUNT(*) n FROM rateLimitWindows`)) as unknown as [Array<{ n: number }>];
    expect(Number(rows[0]!.n)).toBe(1);
  });
});
