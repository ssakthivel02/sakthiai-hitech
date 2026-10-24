import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import mysql from "mysql2";
import { drizzle } from "drizzle-orm/mysql2";
import { sql } from "drizzle-orm";
import { createTestDatabase, mysqlTestUrl, skipMysqlSuite, type TestDatabase } from "../testing/mysqlTestDb";
import { CircuitBreaker, type BreakerRecord } from "./circuitBreaker";
import { MysqlBreakerStore, MysqlBudgetStore, MysqlWorkspacePolicyResolver, PersistedStateError, upsertWorkspaceProviderPolicy, buildGatewayFromEnv } from "./index";
import type { ProviderAdapter } from "./types";

/**
 * Real-SQL tests (MySQL/MariaDB). Each "instance" owns its OWN connection pool, so concurrency goes through
 * the database exactly as it does with several server processes. Skipped only when TEST_DATABASE_URL is absent
 * and MYSQL_REQUIRED!=1 (the CI job and `pnpm test:mysql` set it, making absence a failure).
 */
describe.skipIf(skipMysqlSuite())("MySQL-backed provider policy + runtime enforcement", () => {
  let database: TestDatabase;
  const pools: Array<ReturnType<typeof mysql.createPool>> = [];
  const instanceDb = () => {
    const url = new URL(database.url);
    const pool = mysql.createPool({ host: url.hostname, port: Number(url.port), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database: database.name, connectionLimit: 8 });
    pools.push(pool);
    const db = drizzle(pool);
    return () => Promise.resolve(db);
  };
  const clock = (initial = Date.UTC(2026, 9, 3, 12)) => { const state = { t: initial }; return Object.assign(() => state.t, { state }); };

  beforeAll(async () => { database = await createTestDatabase(); });
  afterAll(async () => { for (const pool of pools) await pool.promise().end().catch(() => undefined); await database?.close(); });
  beforeEach(async () => {
    for (const table of ["providerUsageHolds", "providerUsageWindows", "providerWorkspacePolicies", "providerBreakerStates"]) await database.db.execute(sql.raw(`DELETE FROM ${table}`));
  });

  const reserve = (store: MysqlBudgetStore, workspaceId: number, over: Record<string, unknown> = {}) =>
    store.reserve({ workspaceId, providerId: "external-openai-compatible", requestId: "r", estimatedTokens: 100, policy: { externalEnabled: true, maxRequests: 5 }, ...over } as never);

  describe("budget", () => {
    it("migration created the tables with the expected keys", async () => {
      const [rows] = (await database.db.execute(sql`SELECT TABLE_NAME t, COLUMN_NAME c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ${database.name} AND COLUMN_KEY = 'PRI' AND TABLE_NAME LIKE 'provider%' ORDER BY 1,2`)) as unknown as [Array<{ t: string; c: string }>];
      expect(rows.map(r => `${r.t}.${r.c}`)).toEqual(["providerBreakerStates.providerId", "providerUsageHolds.id", "providerUsageWindows.windowStart", "providerUsageWindows.workspaceId", "providerWorkspacePolicies.workspaceId"]);
    });

    it("two instances racing on one workspace: exactly maxRequests reservations succeed", async () => {
      const a = new MysqlBudgetStore(instanceDb());
      const b = new MysqlBudgetStore(instanceDb());
      const results = await Promise.all(Array.from({ length: 40 }, (_, index) => reserve(index % 2 ? a : b, 1)));
      expect(results.filter(r => r.ok)).toHaveLength(5);
      expect(results.filter(r => !r.ok).every(r => !r.ok && r.reason === "requests_exhausted")).toBe(true);
      expect(await a.usage(1)).toMatchObject({ requests: 5, tokens: 500 });
      expect(await b.usage(1)).toMatchObject({ requests: 5 });
    });

    it("concurrent token budget is never overshot", async () => {
      const stores = [new MysqlBudgetStore(instanceDb()), new MysqlBudgetStore(instanceDb())];
      const results = await Promise.all(Array.from({ length: 30 }, (_, index) => reserve(stores[index % 2], 1, { policy: { externalEnabled: true, maxTokens: 1000 }, estimatedTokens: 300 })));
      expect(results.filter(r => r.ok)).toHaveLength(3); // 3 x 300 <= 1000 < 4 x 300
      expect((await stores[0].usage(1)).tokens).toBe(900);
      expect(results.find(r => !r.ok)).toMatchObject({ reason: "tokens_exhausted" });
    });

    it("cost ceiling is enforced atomically and needs a cost estimate", async () => {
      const store = new MysqlBudgetStore(instanceDb());
      const policy = { externalEnabled: true, maxCost: 1 };
      const results = await Promise.all(Array.from({ length: 10 }, () => reserve(store, 1, { policy, estimatedCost: 0.4 })));
      expect(results.filter(r => r.ok)).toHaveLength(2);
      expect(results.find(r => !r.ok)).toMatchObject({ reason: "cost_exhausted" });
      expect(await reserve(store, 1, { policy })).toMatchObject({ ok: false, reason: "cost_metadata_missing" });
    });

    it("policy preconditions deny before touching counters", async () => {
      const store = new MysqlBudgetStore(instanceDb());
      expect(await reserve(store, 1, { policy: { externalEnabled: false, maxRequests: 5 } })).toMatchObject({ reason: "external_disabled" });
      expect(await reserve(store, 1, { policy: { externalEnabled: true } })).toMatchObject({ reason: "no_limits_configured" });
      expect(await reserve(store, 1, { estimatedTokens: Number.NaN })).toMatchObject({ ok: false });
      expect(await reserve(store, 1, { estimatedTokens: -5 })).toMatchObject({ ok: false });
      expect(await store.usage(1)).toMatchObject({ requests: 0, tokens: 0 });
    });

    it("workspaces are isolated", async () => {
      const store = new MysqlBudgetStore(instanceDb());
      for (let i = 0; i < 5; i += 1) expect((await reserve(store, 1)).ok).toBe(true);
      expect((await reserve(store, 1)).ok).toBe(false);
      expect((await reserve(store, 2)).ok).toBe(true);
      expect(await store.usage(2)).toMatchObject({ requests: 1 });
      expect(await store.usage(3)).toMatchObject({ requests: 0 });
    });

    it("state survives restart: a brand-new store and pool see the same usage", async () => {
      const first = new MysqlBudgetStore(instanceDb());
      for (let i = 0; i < 5; i += 1) await reserve(first, 1);
      for (const pool of pools.splice(0)) await pool.promise().end(); // "process restart"
      const second = new MysqlBudgetStore(instanceDb());
      expect(await second.usage(1)).toMatchObject({ requests: 5 });
      expect(await reserve(second, 1)).toMatchObject({ ok: false, reason: "requests_exhausted" });
    });

    it("commit/release are exactly-once across instances; releases return the hold; commits replace the estimate", async () => {
      const a = new MysqlBudgetStore(instanceDb());
      const b = new MysqlBudgetStore(instanceDb());
      const held = await reserve(a, 1);
      if (!held.ok) throw new Error("setup");
      await Promise.all([a.commit(held.reservation, { tokens: 40, cost: 0, source: "provider_reported" }), b.commit(held.reservation, { tokens: 40, cost: 0, source: "provider_reported" }), b.release(held.reservation)]);
      const usage = await a.usage(1);
      expect(usage.requests === 1 || usage.requests === 0).toBe(true);
      // whichever claimed first wins; the loser is a no-op and never double-counts
      expect(usage.tokens === 40 || usage.tokens === 0).toBe(true);
      const second = await reserve(a, 1);
      if (!second.ok) throw new Error("setup");
      await b.release(second.reservation);
      await a.commit(second.reservation, { tokens: 1, source: "estimated" }); // after release: no-op
      expect(await a.usage(1)).toMatchObject({ requests: usage.requests, tokens: usage.tokens });
    });

    it("actual provider-reported usage replaces the estimate and flags estimated commits", async () => {
      const store = new MysqlBudgetStore(instanceDb());
      const held = await reserve(store, 1);
      if (!held.ok) throw new Error("setup");
      await store.commit(held.reservation, { tokens: 30, source: "provider_reported" });
      expect(await store.usage(1)).toMatchObject({ requests: 1, tokens: 30, estimatedCommits: 0 });
      const held2 = await reserve(store, 1);
      if (!held2.ok) throw new Error("setup");
      await store.commit(held2.reservation, { tokens: 100, source: "estimated" });
      expect(await store.usage(1)).toMatchObject({ requests: 2, tokens: 130, estimatedCommits: 1 });
    });

    it("the daily window rolls over (UTC) and old counters do not leak into the new day", async () => {
      const now = clock();
      const store = new MysqlBudgetStore(instanceDb(), now);
      for (let i = 0; i < 5; i += 1) await reserve(store, 1);
      expect((await reserve(store, 1)).ok).toBe(false);
      now.state.t += 24 * 3600_000;
      expect((await reserve(store, 1)).ok).toBe(true);
      expect(await store.usage(1)).toMatchObject({ requests: 1 });
    });

    it("an unreachable database is an error (the gateway maps it to a denial), never a silent allow", async () => {
      const store = new MysqlBudgetStore(async () => null);
      await expect(reserve(store, 1)).rejects.toThrow(/database unavailable/);
    });
  });

  describe("workspace policy", () => {
    it("no row denies external (explicit opt-in per workspace)", async () => {
      expect(await new MysqlWorkspacePolicyResolver(instanceDb()).resolve(1)).toMatchObject({ externalEnabled: false, meteredEnabled: false });
    });

    it("persists enable/disable, metered flag and limits per workspace; visible to another instance", async () => {
      const getDb = instanceDb();
      await upsertWorkspaceProviderPolicy(getDb, 1, { externalEnabled: true, meteredEnabled: true, maxRequestsPerDay: 10, maxTokensPerDay: 5000, maxCostPerDay: 2.5 });
      await upsertWorkspaceProviderPolicy(getDb, 2, { externalEnabled: true, meteredEnabled: false });
      const other = new MysqlWorkspacePolicyResolver(instanceDb());
      expect(await other.resolve(1)).toEqual({ externalEnabled: true, meteredEnabled: true, maxRequests: 10, maxTokens: 5000, maxCost: 2.5 });
      expect(await other.resolve(2)).toMatchObject({ externalEnabled: true, meteredEnabled: false, maxRequests: undefined });
      await upsertWorkspaceProviderPolicy(getDb, 1, { externalEnabled: false, meteredEnabled: false });
      expect(await other.resolve(1)).toMatchObject({ externalEnabled: false, meteredEnabled: false, maxRequests: undefined });
      expect(await other.resolve(3)).toMatchObject({ externalEnabled: false });
    });

    it("rejects invalid writes and treats corrupt persisted rows as DENY", async () => {
      const getDb = instanceDb();
      await expect(upsertWorkspaceProviderPolicy(getDb, 1, { externalEnabled: true, meteredEnabled: true, maxRequestsPerDay: -1 })).rejects.toThrow();
      await expect(upsertWorkspaceProviderPolicy(getDb, 1, { externalEnabled: true, meteredEnabled: true, maxCostPerDay: Number.NaN })).rejects.toThrow();
      await expect(upsertWorkspaceProviderPolicy(getDb, 1, { externalEnabled: false, meteredEnabled: true })).rejects.toThrow(/requires externalEnabled/);
      await expect(upsertWorkspaceProviderPolicy(getDb, 0, { externalEnabled: true, meteredEnabled: false })).rejects.toThrow();
      // bypass validation the way a bad manual edit would
      await database.db.execute(sql`INSERT INTO providerWorkspacePolicies (workspaceId, externalEnabled, meteredEnabled, maxRequestsPerDay) VALUES (9, 1, 1, 0)`);
      await database.db.execute(sql`INSERT INTO providerWorkspacePolicies (workspaceId, externalEnabled, meteredEnabled, maxRequestsPerDay) VALUES (10, 1, 1, -4)`);
      await database.db.execute(sql`INSERT INTO providerWorkspacePolicies (workspaceId, externalEnabled, meteredEnabled, maxRequestsPerDay) VALUES (11, 5, 0, 10)`); // tinyint(1) holding a non-boolean
      const resolver = new MysqlWorkspacePolicyResolver(getDb);
      expect(await resolver.resolve(11)).toMatchObject({ externalEnabled: false, meteredEnabled: false });
      expect(await resolver.resolve(9)).toMatchObject({ externalEnabled: false, meteredEnabled: false });
      expect(await resolver.resolve(10)).toMatchObject({ externalEnabled: false, meteredEnabled: false });
    });
  });

  describe("circuit breaker", () => {
    const config = { failureThreshold: 2, cooldownMs: 1000 };
    const breakerOn = (getDb: ReturnType<typeof instanceDb>, now: () => number) => new CircuitBreaker(new MysqlBreakerStore(getDb), config, now);

    it("OPEN on one instance is OPEN on another; HALF_OPEN admits exactly one probe across instances; success closes everywhere", async () => {
      const now = clock();
      const a = breakerOn(instanceDb(), now);
      const b = breakerOn(instanceDb(), now);
      await a.recordFailure("p");
      expect((await b.admit("p")).allowed).toBe(true); // still CLOSED
      await b.recordFailure("p");
      expect(await a.admit("p")).toEqual({ allowed: false, state: "OPEN" });
      expect(await b.state("p")).toBe("OPEN");

      now.state.t += 1500; // cooldown over -> many concurrent callers on both instances race for the probe
      const racers = await Promise.all(Array.from({ length: 24 }, (_, i) => (i % 2 ? a : b).admit("p")));
      expect(racers.filter(r => r.allowed)).toHaveLength(1);
      expect(racers.find(r => r.allowed)).toMatchObject({ state: "HALF_OPEN", probe: true });

      await b.recordSuccess("p");
      expect(await a.state("p")).toBe("CLOSED");
      expect((await a.admit("p")).allowed).toBe(true);
    });

    it("a failed probe re-opens the circuit for every instance", async () => {
      const now = clock();
      const a = breakerOn(instanceDb(), now);
      const b = breakerOn(instanceDb(), now);
      await a.recordFailure("p"); await a.recordFailure("p");
      now.state.t += 1500;
      expect((await b.admit("p")).allowed).toBe(true);
      await b.recordFailure("p");
      expect(await a.admit("p")).toEqual({ allowed: false, state: "OPEN" });
      now.state.t += 1500;
      expect((await a.admit("p")).allowed).toBe(true); // next cooldown, next probe
    });

    it("a neutral result releases the probe slot; a lost probe expires after one cooldown", async () => {
      const now = clock();
      const a = breakerOn(instanceDb(), now);
      const b = breakerOn(instanceDb(), now);
      await a.recordFailure("p"); await a.recordFailure("p");
      now.state.t += 1500;
      expect((await a.admit("p")).allowed).toBe(true);
      expect((await b.admit("p")).allowed).toBe(false);
      await a.recordNeutral("p");
      expect((await b.admit("p")).allowed).toBe(true);
      now.state.t += 1500; // b never reported back
      expect((await a.admit("p")).allowed).toBe(true);
    });

    it("providers are isolated and state survives restart", async () => {
      const now = clock();
      const first = breakerOn(instanceDb(), now);
      await first.recordFailure("p"); await first.recordFailure("p");
      for (const pool of pools.splice(0)) await pool.promise().end();
      const second = breakerOn(instanceDb(), now);
      expect((await second.admit("p")).allowed).toBe(false);
      expect((await second.admit("q")).allowed).toBe(true);
    });

    it("concurrent failures from many instances are not lost (CAS retries)", async () => {
      const now = clock();
      const breakers = Array.from({ length: 4 }, () => breakerOn(instanceDb(), now));
      const wide = { failureThreshold: 20, cooldownMs: 1000 };
      const shared = breakers.map((_, i) => new CircuitBreaker(new MysqlBreakerStore(instanceDb()), wide, now));
      await Promise.all(Array.from({ length: 19 }, (_, i) => shared[i % 4].recordFailure("w")));
      expect(await shared[0].state("w")).toBe("CLOSED");
      await shared[1].recordFailure("w");
      expect(await shared[2].state("w")).toBe("OPEN"); // exactly 20 failures counted, none lost
    });

    it("malformed persisted state fails safe: external is denied, self-hosted stays available, readers get a typed error", async () => {
      const getDb = instanceDb();
      const store = new MysqlBreakerStore(getDb);
      const breaker = new CircuitBreaker(store, config, clock());
      await database.db.execute(sql`INSERT INTO providerBreakerStates (providerId, state, consecutiveFailures, openedAt) VALUES ('bad', 'CLOSED', -7, 0)`);
      await expect(store.get("bad")).rejects.toBeInstanceOf(PersistedStateError);
      expect(await breaker.admit("bad")).toEqual({ allowed: false, state: "OPEN" });
      expect((await breaker.admit("bad", { failOpen: true })).allowed).toBe(true);
      expect(await breaker.state("bad")).toBe("OPEN");
      await database.db.execute(sql`UPDATE providerBreakerStates SET consecutiveFailures = 0, openedAt = -1 WHERE providerId = 'bad'`);
      await expect(store.get("bad")).rejects.toBeInstanceOf(PersistedStateError);
      // an operator repair (or a success) restores service
      await breaker.recordSuccess("bad");
      expect((await breaker.admit("bad")).allowed).toBe(true);
    });

    it("compareAndSet semantics: insert-if-absent and conflict detection", async () => {
      const store = new MysqlBreakerStore(instanceDb());
      const rec: BreakerRecord = { state: "CLOSED", consecutiveFailures: 1, openedAt: 0, probeInFlightSince: null };
      expect(await store.compareAndSet("x", undefined, rec)).toBe(true);
      expect(await store.compareAndSet("x", undefined, rec)).toBe(false);
      expect(await store.compareAndSet("x", { ...rec, consecutiveFailures: 0 }, { ...rec, consecutiveFailures: 2 })).toBe(false);
      expect(await store.compareAndSet("x", rec, { ...rec, consecutiveFailures: 2 })).toBe(true);
      expect((await store.get("x"))?.consecutiveFailures).toBe(2);
    });
  });

  describe("two full gateway instances sharing one database", () => {
    const stub: ProviderAdapter = { providerId: "x", complete: async () => ({ content: "ok", finishReason: "stop", usage: { totalTokens: 50 }, attempts: 1 }) };
    const env = { LLM_API_URL: "https://external.test.invalid", LLM_MODEL: "m", GATEWAY_ALLOW_EXTERNAL: "true", GATEWAY_ALLOW_METERED: "true", GATEWAY_STATE_STORE: "mysql", GATEWAY_MAX_OUTPUT_TOKENS: "10" };
    const gateway = () => buildGatewayFromEnv(env, { log: () => undefined, adapterFactory: binding => ({ ...stub, providerId: binding.providerId }) }, instanceDb());
    const call = (g: ReturnType<typeof gateway>, workspaceId: number) => g.invoke({ requestId: `r${Math.random()}`, workspaceId, messages: [{ role: "user", content: "hi" }] });

    it("workspace policy + budget are enforced across instances, per workspace, with provider-reported usage", async () => {
      const a = gateway();
      const b = gateway();
      const getDb = instanceDb();
      expect((await call(a, 1)).status).toBe("failed"); // no policy row => denied
      await upsertWorkspaceProviderPolicy(getDb, 1, { externalEnabled: true, meteredEnabled: true, maxRequestsPerDay: 3 });
      await upsertWorkspaceProviderPolicy(getDb, 2, { externalEnabled: true, meteredEnabled: false, maxRequestsPerDay: 3 });
      await upsertWorkspaceProviderPolicy(getDb, 3, { externalEnabled: false, meteredEnabled: false });
      const results = await Promise.all(Array.from({ length: 12 }, (_, i) => call(i % 2 ? a : b, 1)));
      expect(results.filter(r => r.status === "returned")).toHaveLength(3);
      expect(results.find(r => r.status === "failed")).toMatchObject({ reason: "budget_denied" });
      expect(await call(a, 2)).toMatchObject({ status: "failed", reason: "budget_denied" }); // metered disabled for ws 2
      expect(await call(b, 3)).toMatchObject({ status: "failed" }); // external disabled for ws 3
      expect(await a.budgetStore!.usage(1)).toMatchObject({ requests: 3, tokens: 150 }); // provider-reported 50 each, not estimates
      expect(await b.budgetStore!.usage(2)).toMatchObject({ requests: 0 });
      // disabling a workspace takes effect on every instance immediately
      await upsertWorkspaceProviderPolicy(getDb, 1, { externalEnabled: false, meteredEnabled: false });
      expect((await call(a, 1)).status).toBe("failed");
    });
  });

  it("uses the configured throwaway database only", () => {
    expect(mysqlTestUrl()).not.toContain(database.name);
    expect(database.name).toMatch(/^sakthi_it_/);
  });
});
