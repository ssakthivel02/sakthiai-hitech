import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import mysql from "mysql2";
import { drizzle } from "drizzle-orm/mysql2";
import { sql } from "drizzle-orm";
import { createTestDatabase, skipMysqlSuite, type TestDatabase } from "../testing/mysqlTestDb";
import { InMemoryRateLimiter } from "./rateLimit";
import { MysqlRateLimiter } from "./sharedRateLimit";

/**
 * Real-SQL tests of the shared limiter. Each "instance" has its own connection pool, so concurrency goes through the
 * database exactly as it does with several server processes. The proposal table is applied to the throwaway database only.
 */
describe.skipIf(skipMysqlSuite())("MySQL-shared authenticated rate limiter", () => {
  let database: TestDatabase;
  const pools: Array<ReturnType<typeof mysql.createPool>> = [];
  const instance = () => {
    const url = new URL(database.url);
    const pool = mysql.createPool({ host: url.hostname, port: Number(url.port), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database: database.name, connectionLimit: 8 });
    pools.push(pool);
    const db = drizzle(pool);
    return new MysqlRateLimiter(async () => db, new InMemoryRateLimiter(), e => { throw e; });
  };
  const policy = { name: "chat-send", maxRequests: 5, windowMs: 60_000 };
  const T0 = Date.UTC(2026, 9, 24, 12, 0, 0);

  beforeAll(async () => {
    database = await createTestDatabase();
    const proposal = readFileSync("drizzle/proposals/rate_limit_windows.sql", "utf8").split("--> statement-breakpoint").map(s => s.replace(/^--.*$/gm, "").trim()).filter(Boolean);
    for (const statement of proposal) await database.pool.promise().query(statement);
  });
  afterAll(async () => { for (const pool of pools) await pool.promise().end().catch(() => undefined); await database?.close(); });
  beforeEach(async () => { await database.db.execute(sql`DELETE FROM rateLimitWindows`); });

  it("three instances share ONE budget: exactly maxRequests of 30 concurrent requests are admitted", async () => {
    const [a, b, c] = [instance(), instance(), instance()];
    const results = await Promise.all(Array.from({ length: 30 }, (_, i) => [a, b, c][i % 3]!.consume("user:7", policy, T0 + i)));
    expect(results.filter(r => r.allowed)).toHaveLength(5);
    expect(results.filter(r => !r.allowed).every(r => r.retryAfterMs > 0 && r.remaining === 0)).toBe(true);
    for (const l of [a, b, c]) expect(l.status().fallback).toBe(0);
  });

  it("users and policies are isolated; the next aligned window starts fresh", async () => {
    const l = instance();
    for (let i = 0; i < 5; i++) expect((await l.consume("user:1", policy, T0 + i)).allowed).toBe(true);
    expect((await l.consume("user:1", policy, T0 + 10)).allowed).toBe(false);
    expect((await l.consume("user:2", policy, T0 + 11)).allowed).toBe(true);
    expect((await l.consume("user:1", { ...policy, name: "authenticated-default" }, T0 + 12)).allowed).toBe(true);
    const next = await l.consume("user:1", policy, T0 + policy.windowMs);
    expect(next).toMatchObject({ allowed: true, remaining: 4, resetAt: T0 + 2 * policy.windowMs });
  });

  it("an instance whose clock is behind cannot reset a newer window", async () => {
    const ahead = instance(); const behind = instance();
    for (let i = 0; i < 5; i++) await ahead.consume("user:3", policy, T0 + policy.windowMs + i);
    expect((await behind.consume("user:3", policy, T0 + 5)).allowed).toBe(false);
  });

  it("expired windows are pruned (bounded) without affecting decisions", async () => {
    const l = instance();
    for (let u = 0; u < 20; u++) await database.db.execute(sql`INSERT INTO rateLimitWindows (bucketKey, windowStart, count, expiresAt) VALUES (${`chat-send:user:old${u}`}, ${T0 - 600_000}, 3, ${T0 - 540_000})`);
    expect((await l.consume("user:9", policy, T0)).allowed).toBe(true);
    await new Promise(r => setTimeout(r, 200));
    const [rows] = (await database.db.execute(sql`SELECT COUNT(*) n FROM rateLimitWindows`)) as unknown as [Array<{ n: number }>];
    expect(Number(rows[0]!.n)).toBe(1);
  });
});
