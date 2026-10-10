import { sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/mysql2";
import { getDb } from "../db";
import type { CreatorPaidKind, CreatorSpendLimits } from "./paidPolicy";

/**
 * Database-backed Creator spend ledger, shared by every server instance (migration 0011).
 *
 * reserve(): ONE transaction that (1) inserts the hold row keyed by workspace + idempotency key and (2) applies a
 * guarded `UPDATE ... WHERE generations + 1 <= max AND cost + c <= maxCost` to the global, workspace and user
 * scopes in a fixed order. Any failed guard throws inside the transaction, rolling back the hold and every counter
 * (all-or-nothing). InnoDB row locks serialise concurrent reservers, so exactly the allowed number succeed.
 * A second reserve() with the same hold id never counts twice (`created: false`).
 *
 * Settlement: commit/release are guarded by `state = 'HELD'` so they apply at most once across instances.
 * Ambiguous provider outcomes stay HELD (counted as spent). Stale holds are never auto-released.
 */
type Db = ReturnType<typeof drizzle>;
export type CreatorSpendDbProvider = () => Promise<Db | null | undefined>;

export type CreatorSpendScope = "global" | "workspace" | "user";
export type CreatorSpendReserveInput = {
  holdId: string;
  workspaceId: number;
  userId: number;
  kind: CreatorPaidKind;
  model: string;
  cost: number;
  limits: CreatorSpendLimits;
};
export type CreatorSpendReserveResult =
  | { ok: true; created: boolean }
  | { ok: false; reason: `${CreatorSpendScope}_exhausted` };

export interface CreatorSpendLedger {
  reserve(input: CreatorSpendReserveInput): Promise<CreatorSpendReserveResult>;
  commit(holdId: string, generationId: number): Promise<void>;
  release(holdId: string): Promise<void>;
  recordUnknown(holdId: string, generationId: number): Promise<void>;
}

/** Deterministic: one hold per (workspace, idempotency key), so a reused key can never reserve twice. */
export function creatorHoldId(workspaceId: number, idempotencyKey: string): string {
  return `ws:${workspaceId}:${idempotencyKey.trim()}`.slice(0, 96);
}

const dayKey = (at: number) => new Date(at).toISOString().slice(0, 10);
const affected = (result: unknown): number => Number((Array.isArray(result) ? (result[0] as { affectedRows?: number }) : (result as { affectedRows?: number }))?.affectedRows ?? 0);
const rowsOf = <T>(result: unknown): T[] => (Array.isArray(result) ? (Array.isArray(result[0]) ? (result[0] as T[]) : (result as T[])) : []);

function errno(error: unknown): number | undefined {
  for (let current: unknown = error, depth = 0; current && typeof current === "object" && depth < 5; depth++) {
    const candidate = current as { errno?: unknown; cause?: unknown };
    if (typeof candidate.errno === "number") return candidate.errno;
    current = candidate.cause;
  }
  return undefined;
}

class ScopeExhausted extends Error {
  constructor(readonly scope: CreatorSpendScope) {
    super(`${scope}_exhausted`);
  }
}

const RETRYABLE_LOCK_ERRORS = new Set([1213 /* deadlock */, 1205 /* lock wait timeout */]);

export class MysqlCreatorSpendLedger implements CreatorSpendLedger {
  constructor(private readonly getDbProvider: CreatorSpendDbProvider, private readonly now: () => number = Date.now) {}

  private async db(): Promise<Db> {
    const db = await this.getDbProvider();
    if (!db) throw new Error("CREATOR_SPEND_LEDGER_UNAVAILABLE");
    return db;
  }

  async reserve(input: CreatorSpendReserveInput): Promise<CreatorSpendReserveResult> {
    if (!Number.isFinite(input.cost) || input.cost < 0) throw new Error("CREATOR_SPEND_INVALID_COST");
    const db = await this.db();
    const day = dayKey(this.now());
    const scopes: Array<[CreatorSpendScope, string, number, number]> = [
      ["global", "global", input.limits.globalGenerations, input.limits.globalCost],
      ["workspace", `workspace:${input.workspaceId}`, input.limits.workspaceGenerations, input.limits.workspaceCost],
      ["user", `user:${input.userId}`, input.limits.userGenerations, input.limits.userCost],
    ];
    for (let attempt = 1; ; attempt++) {
      try {
        return await db.transaction(async tx => {
          try {
            await tx.execute(sql`INSERT INTO creatorSpendHolds (id, workspaceId, userId, kind, model, windowStart, cost, state)
              VALUES (${input.holdId}, ${input.workspaceId}, ${input.userId}, ${input.kind}, ${input.model.slice(0, 128)}, ${day}, ${input.cost}, 'HELD')`);
          } catch (error) {
            if (errno(error) === 1062) return { ok: true, created: false } as const; // same key already reserved
            throw error;
          }
          for (const [scope, key, maxGenerations, maxCost] of scopes) {
            await tx.execute(sql`INSERT INTO creatorSpendWindows (scope, windowStart) VALUES (${key}, ${day}) ON DUPLICATE KEY UPDATE scope = scope`);
            const update = await tx.execute(sql`UPDATE creatorSpendWindows SET generations = generations + 1, cost = cost + ${input.cost}
              WHERE scope = ${key} AND windowStart = ${day} AND generations + 1 <= ${maxGenerations} AND cost + ${input.cost} <= ${maxCost}`);
            if (affected(update) !== 1) throw new ScopeExhausted(scope);
          }
          return { ok: true, created: true } as const;
        });
      } catch (error) {
        if (error instanceof ScopeExhausted) return { ok: false, reason: `${error.scope}_exhausted` };
        if (attempt < 3 && RETRYABLE_LOCK_ERRORS.has(errno(error) ?? 0)) continue;
        throw error;
      }
    }
  }

  async commit(holdId: string, generationId: number): Promise<void> {
    const db = await this.db();
    await db.execute(sql`UPDATE creatorSpendHolds SET state = 'COMMITTED', generationId = ${generationId}, settledAt = CURRENT_TIMESTAMP WHERE id = ${holdId} AND state = 'HELD'`);
  }

  async recordUnknown(holdId: string, generationId: number): Promise<void> {
    const db = await this.db();
    await db.execute(sql`UPDATE creatorSpendHolds SET generationId = ${generationId} WHERE id = ${holdId} AND state = 'HELD'`);
  }

  async release(holdId: string): Promise<void> {
    const db = await this.db();
    await db.transaction(async tx => {
      const claimed = await tx.execute(sql`UPDATE creatorSpendHolds SET state = 'RELEASED', settledAt = CURRENT_TIMESTAMP WHERE id = ${holdId} AND state = 'HELD'`);
      if (affected(claimed) !== 1) return; // already settled, possibly by another instance
      const hold = rowsOf<{ workspaceId: unknown; userId: unknown; windowStart: unknown; cost: unknown }>(
        await tx.execute(sql`SELECT workspaceId, userId, windowStart, cost FROM creatorSpendHolds WHERE id = ${holdId}`),
      )[0];
      if (!hold) return;
      const day = hold.windowStart instanceof Date ? hold.windowStart.toISOString().slice(0, 10) : String(hold.windowStart);
      const cost = Number(hold.cost);
      for (const key of ["global", `workspace:${Number(hold.workspaceId)}`, `user:${Number(hold.userId)}`]) {
        await tx.execute(sql`UPDATE creatorSpendWindows SET generations = GREATEST(generations - 1, 0), cost = GREATEST(cost - ${cost}, 0) WHERE scope = ${key} AND windowStart = ${day}`);
      }
    });
  }
}

let ledger: CreatorSpendLedger | undefined;
export function getCreatorSpendLedger(): CreatorSpendLedger {
  ledger ??= new MysqlCreatorSpendLedger(getDb);
  return ledger;
}
