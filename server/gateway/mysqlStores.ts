import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/mysql2";
import { hasAnyBudgetLimit, type ActualUsage, type BudgetStore, type ReserveInput, type ReserveResult, type Reservation, type WorkspaceBudgetPolicy } from "./budget";
import type { BreakerRecord, BreakerState, BreakerStore } from "./circuitBreaker";
import type { WorkspacePolicyResolver } from "./gateway";

/**
 * MySQL-backed provider policy, usage budget and circuit-breaker state, shared by every server instance.
 *
 * Atomicity strategy (no advisory locks, no read-then-write races):
 *  - Budget reserve: ONE conditional UPDATE (`requests+1 <= max AND tokens+n <= max ...`). InnoDB row locking
 *    serialises concurrent reservers; exactly the allowed number succeed.
 *  - Commit / release: guarded by `UPDATE ... SET state=... WHERE id=? AND state='HELD'` so they apply once.
 *  - Breaker: compare-and-set on the previously read values.
 * All stores fail closed: a database problem surfaces as an exception the gateway maps to a denial
 * (self-hosted providers excepted, see CircuitBreaker.admit).
 *
 * Stale HELD reservations (an instance died mid-call) remain counted: conservative by design.
 */
type Db = ReturnType<typeof drizzle>;
export type DbProvider = () => Promise<Db | null | undefined>;

export class PersistedStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersistedStateError";
  }
}

async function requireDb(getDb: DbProvider): Promise<Db> {
  const db = await getDb();
  if (!db) throw new Error("database unavailable");
  return db;
}

type Header = { affectedRows?: number };
const affected = (result: unknown): number => {
  const header = Array.isArray(result) ? (result[0] as Header) : (result as Header);
  return Number(header?.affectedRows ?? 0);
};
const rowsOf = <T>(result: unknown): T[] => (Array.isArray(result) && Array.isArray(result[0]) ? (result[0] as T[]) : []);

const dayKey = (at: number) => new Date(at).toISOString().slice(0, 10);
const num = (value: unknown): number => {
  const parsed = typeof value === "number" ? value : Number(value);
  return parsed;
};
const finiteNonNegative = (value: unknown) => Number.isFinite(num(value)) && num(value) >= 0;

// ---------------------------------------------------------------- budget

export class MysqlBudgetStore implements BudgetStore {
  constructor(private readonly getDb: DbProvider, private readonly now: () => number = Date.now) {}

  async reserve(input: ReserveInput): Promise<ReserveResult> {
    const { policy } = input;
    if (!policy.externalEnabled) return { ok: false, reason: "external_disabled" };
    if (!hasAnyBudgetLimit(policy)) return { ok: false, reason: "no_limits_configured" };
    if (policy.maxCost !== undefined && input.estimatedCost === undefined) return { ok: false, reason: "cost_metadata_missing" };
    if (!Number.isFinite(input.estimatedTokens) || input.estimatedTokens < 0) return { ok: false, reason: "store_unavailable" };
    const cost = input.estimatedCost ?? 0;
    if (!Number.isFinite(cost) || cost < 0) return { ok: false, reason: "store_unavailable" };

    const db = await requireDb(this.getDb);
    const day = dayKey(this.now());
    const tokens = Math.ceil(input.estimatedTokens);
    return db.transaction(async tx => {
      await tx.execute(sql`INSERT INTO providerUsageWindows (workspaceId, windowStart) VALUES (${input.workspaceId}, ${day}) ON DUPLICATE KEY UPDATE workspaceId = workspaceId`);
      const guards = [sql`workspaceId = ${input.workspaceId}`, sql`windowStart = ${day}`];
      if (policy.maxRequests !== undefined) guards.push(sql`requests + 1 <= ${policy.maxRequests}`);
      if (policy.maxTokens !== undefined) guards.push(sql`tokens + ${tokens} <= ${policy.maxTokens}`);
      if (policy.maxCost !== undefined) guards.push(sql`cost + ${cost} <= ${policy.maxCost}`);
      const update = await tx.execute(sql`UPDATE providerUsageWindows SET requests = requests + 1, tokens = tokens + ${tokens}, cost = cost + ${cost} WHERE ${sql.join(guards, sql` AND `)}`);
      if (affected(update) !== 1) {
        const current = rowsOf<{ requests: unknown; tokens: unknown; cost: unknown }>(await tx.execute(sql`SELECT requests, tokens, cost FROM providerUsageWindows WHERE workspaceId = ${input.workspaceId} AND windowStart = ${day}`))[0];
        if (!current) return { ok: false, reason: "store_unavailable" } as ReserveResult;
        if (policy.maxRequests !== undefined && num(current.requests) + 1 > policy.maxRequests) return { ok: false, reason: "requests_exhausted" } as ReserveResult;
        if (policy.maxTokens !== undefined && num(current.tokens) + tokens > policy.maxTokens) return { ok: false, reason: "tokens_exhausted" } as ReserveResult;
        return { ok: false, reason: "cost_exhausted" } as ReserveResult;
      }
      const id = randomUUID();
      await tx.execute(sql`INSERT INTO providerUsageHolds (id, workspaceId, providerId, windowStart, tokens, cost, state) VALUES (${id}, ${input.workspaceId}, ${input.providerId.slice(0, 96)}, ${day}, ${tokens}, ${cost}, 'HELD')`);
      return { ok: true, reservation: { id, workspaceId: input.workspaceId, providerId: input.providerId } } as ReserveResult;
    });
  }

  async commit(reservation: Reservation, actual: ActualUsage): Promise<void> {
    const db = await requireDb(this.getDb);
    await db.transaction(async tx => {
      const claimed = await tx.execute(sql`UPDATE providerUsageHolds SET state = 'COMMITTED' WHERE id = ${reservation.id} AND state = 'HELD'`);
      if (affected(claimed) !== 1) return; // already committed/released (possibly by another instance)
      const hold = rowsOf<{ workspaceId: unknown; windowStart: unknown; tokens: unknown; cost: unknown }>(await tx.execute(sql`SELECT workspaceId, windowStart, tokens, cost FROM providerUsageHolds WHERE id = ${reservation.id}`))[0];
      if (!hold) return;
      const tokenDelta = actual.tokens !== undefined && Number.isFinite(actual.tokens) && actual.tokens >= 0 ? Math.round(actual.tokens) - num(hold.tokens) : 0;
      const costDelta = actual.cost !== undefined && Number.isFinite(actual.cost) && actual.cost >= 0 ? actual.cost - num(hold.cost) : 0;
      await tx.execute(sql`UPDATE providerUsageWindows SET tokens = tokens + ${tokenDelta}, cost = cost + ${costDelta}, estimatedCommits = estimatedCommits + ${actual.source === "estimated" ? 1 : 0} WHERE workspaceId = ${num(hold.workspaceId)} AND windowStart = ${String(hold.windowStart instanceof Date ? hold.windowStart.toISOString().slice(0, 10) : hold.windowStart)}`);
    });
  }

  async release(reservation: Reservation): Promise<void> {
    const db = await requireDb(this.getDb);
    await db.transaction(async tx => {
      const claimed = await tx.execute(sql`UPDATE providerUsageHolds SET state = 'RELEASED' WHERE id = ${reservation.id} AND state = 'HELD'`);
      if (affected(claimed) !== 1) return;
      const hold = rowsOf<{ workspaceId: unknown; windowStart: unknown; tokens: unknown; cost: unknown }>(await tx.execute(sql`SELECT workspaceId, windowStart, tokens, cost FROM providerUsageHolds WHERE id = ${reservation.id}`))[0];
      if (!hold) return;
      await tx.execute(sql`UPDATE providerUsageWindows SET requests = requests - 1, tokens = tokens - ${num(hold.tokens)}, cost = cost - ${num(hold.cost)} WHERE workspaceId = ${num(hold.workspaceId)} AND windowStart = ${String(hold.windowStart instanceof Date ? hold.windowStart.toISOString().slice(0, 10) : hold.windowStart)}`);
    });
  }

  async usage(workspaceId: number) {
    const db = await requireDb(this.getDb);
    const row = rowsOf<{ requests: unknown; tokens: unknown; cost: unknown; estimatedCommits: unknown }>(
      await db.execute(sql`SELECT requests, tokens, cost, estimatedCommits FROM providerUsageWindows WHERE workspaceId = ${workspaceId} AND windowStart = ${dayKey(this.now())}`),
    )[0];
    return row ? { requests: num(row.requests), tokens: num(row.tokens), cost: num(row.cost), estimatedCommits: num(row.estimatedCommits) } : { requests: 0, tokens: 0, cost: 0, estimatedCommits: 0 };
  }
}

// ---------------------------------------------------------------- policy

const DENY_ALL: WorkspaceBudgetPolicy = { externalEnabled: false, meteredEnabled: false };

/** Positive finite integer-ish limit, or undefined when NULL; `"invalid"` for anything else. */
function limit(value: unknown): number | undefined | "invalid" {
  if (value === null || value === undefined) return undefined;
  const parsed = num(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : "invalid";
}

export class MysqlWorkspacePolicyResolver implements WorkspacePolicyResolver {
  constructor(private readonly getDb: DbProvider) {}

  /** No row => external DENIED (explicit per-workspace enablement). Corrupt row => DENIED. DB error => throws (gateway fails closed). */
  async resolve(workspaceId: number): Promise<WorkspaceBudgetPolicy> {
    const db = await requireDb(this.getDb);
    const row = rowsOf<Record<string, unknown>>(await db.execute(sql`SELECT externalEnabled, meteredEnabled, maxRequestsPerDay, maxTokensPerDay, maxCostPerDay FROM providerWorkspacePolicies WHERE workspaceId = ${workspaceId}`))[0];
    if (!row) return { ...DENY_ALL };
    const flags = [row.externalEnabled, row.meteredEnabled].map(value => (value === 1 || value === true || value === "1" ? true : value === 0 || value === false || value === "0" ? false : null));
    const maxRequests = limit(row.maxRequestsPerDay);
    const maxTokens = limit(row.maxTokensPerDay);
    const maxCost = limit(row.maxCostPerDay);
    if (flags.includes(null) || maxRequests === "invalid" || maxTokens === "invalid" || maxCost === "invalid") return { ...DENY_ALL };
    return { externalEnabled: flags[0] === true, meteredEnabled: flags[1] === true, maxRequests, maxTokens, maxCost };
  }
}

export type WorkspaceProviderPolicyInput = { externalEnabled: boolean; meteredEnabled: boolean; maxRequestsPerDay?: number | null; maxTokensPerDay?: number | null; maxCostPerDay?: number | null };

/** Operator/admin write path. Validates before persisting; never accepts non-positive limits. */
export async function upsertWorkspaceProviderPolicy(getDb: DbProvider, workspaceId: number, input: WorkspaceProviderPolicyInput): Promise<void> {
  if (!Number.isInteger(workspaceId) || workspaceId <= 0) throw new Error("invalid workspaceId");
  for (const [name, value] of [["maxRequestsPerDay", input.maxRequestsPerDay], ["maxTokensPerDay", input.maxTokensPerDay], ["maxCostPerDay", input.maxCostPerDay]] as const) {
    if (value !== undefined && value !== null && !(Number.isFinite(value) && value > 0)) throw new Error(`${name} must be a positive number or null`);
  }
  if (input.meteredEnabled && !input.externalEnabled) throw new Error("meteredEnabled requires externalEnabled");
  const db = await requireDb(getDb);
  const requests = input.maxRequestsPerDay ?? null;
  const tokens = input.maxTokensPerDay ?? null;
  const cost = input.maxCostPerDay ?? null;
  await db.execute(sql`INSERT INTO providerWorkspacePolicies (workspaceId, externalEnabled, meteredEnabled, maxRequestsPerDay, maxTokensPerDay, maxCostPerDay)
    VALUES (${workspaceId}, ${input.externalEnabled ? 1 : 0}, ${input.meteredEnabled ? 1 : 0}, ${requests}, ${tokens}, ${cost})
    ON DUPLICATE KEY UPDATE externalEnabled = VALUES(externalEnabled), meteredEnabled = VALUES(meteredEnabled), maxRequestsPerDay = VALUES(maxRequestsPerDay), maxTokensPerDay = VALUES(maxTokensPerDay), maxCostPerDay = VALUES(maxCostPerDay)`);
}

// ---------------------------------------------------------------- breaker

const BREAKER_STATES: readonly BreakerState[] = ["CLOSED", "OPEN", "HALF_OPEN"];

function parseBreakerRow(providerId: string, row: Record<string, unknown>): BreakerRecord {
  const state = row.state as BreakerState;
  const failures = num(row.consecutiveFailures);
  const openedAt = num(row.openedAt);
  const probe = row.probeInFlightSince === null || row.probeInFlightSince === undefined ? null : num(row.probeInFlightSince);
  if (!BREAKER_STATES.includes(state) || !Number.isInteger(failures) || failures < 0 || !finiteNonNegative(openedAt) || (probe !== null && !finiteNonNegative(probe))) {
    throw new PersistedStateError(`corrupt breaker state for ${providerId}`);
  }
  return { state, consecutiveFailures: failures, openedAt, probeInFlightSince: probe };
}

export class MysqlBreakerStore implements BreakerStore {
  constructor(private readonly getDb: DbProvider) {}

  async get(providerId: string): Promise<BreakerRecord | undefined> {
    const db = await requireDb(this.getDb);
    const row = rowsOf<Record<string, unknown>>(await db.execute(sql`SELECT state, consecutiveFailures, openedAt, probeInFlightSince FROM providerBreakerStates WHERE providerId = ${providerId}`))[0];
    return row ? parseBreakerRow(providerId, row) : undefined;
  }

  async set(providerId: string, record: BreakerRecord): Promise<void> {
    const db = await requireDb(this.getDb);
    await db.execute(sql`INSERT INTO providerBreakerStates (providerId, state, consecutiveFailures, openedAt, probeInFlightSince)
      VALUES (${providerId}, ${record.state}, ${record.consecutiveFailures}, ${record.openedAt}, ${record.probeInFlightSince})
      ON DUPLICATE KEY UPDATE state = VALUES(state), consecutiveFailures = VALUES(consecutiveFailures), openedAt = VALUES(openedAt), probeInFlightSince = VALUES(probeInFlightSince)`);
  }

  async compareAndSet(providerId: string, expected: BreakerRecord | undefined, next: BreakerRecord): Promise<boolean> {
    const db = await requireDb(this.getDb);
    if (!expected) {
      const inserted = await db.execute(sql`INSERT IGNORE INTO providerBreakerStates (providerId, state, consecutiveFailures, openedAt, probeInFlightSince) VALUES (${providerId}, ${next.state}, ${next.consecutiveFailures}, ${next.openedAt}, ${next.probeInFlightSince})`);
      return affected(inserted) === 1;
    }
    const updated = await db.execute(sql`UPDATE providerBreakerStates SET state = ${next.state}, consecutiveFailures = ${next.consecutiveFailures}, openedAt = ${next.openedAt}, probeInFlightSince = ${next.probeInFlightSince}
      WHERE providerId = ${providerId} AND state = ${expected.state} AND consecutiveFailures = ${expected.consecutiveFailures} AND openedAt = ${expected.openedAt} AND probeInFlightSince <=> ${expected.probeInFlightSince}`);
    return affected(updated) === 1;
  }
}
