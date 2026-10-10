import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/mysql2";
import { TERMINAL_STATES, TaskIdempotencyConflict, type TaskFailureClass, type TaskRecord, type TaskState, type TaskView } from "./types";

/**
 * MySQL-backed durable task store. Every transition is one conditional UPDATE (no read-then-write):
 *  - claim: candidates are selected, then CLAIMED by an UPDATE re-checking eligibility, so two workers racing for one task
 *    cannot both win; an expired RUNNING lease is recoverable; attempts are bounded by maxAttempts.
 *  - fencing: every worker mutation requires (leaseOwner, attempt) to still match; a worker whose lease was taken over
 *    (attempt incremented) can no longer checkpoint, complete or fail the task.
 *  - time: all comparisons use the database clock (NOW(3)), never instance clocks.
 * Reads and cancellation are always scoped by workspaceId: a task of another workspace is indistinguishable from absent.
 */
type Db = ReturnType<typeof drizzle>;
export type DbProvider = () => Promise<Db | null | undefined>;
type Header = { affectedRows?: number };
const affected = (result: unknown) => Number(((Array.isArray(result) ? result[0] : result) as Header)?.affectedRows ?? 0);
const rowsOf = <T>(result: unknown): T[] => (Array.isArray(result) && Array.isArray(result[0]) ? (result[0] as T[]) : []);
const MAX_JSON_BYTES = 60_000;

const encode = (value: unknown, what: string): string => {
  const text = JSON.stringify(value ?? null);
  if (Buffer.byteLength(text, "utf8") > MAX_JSON_BYTES) throw new Error(`${what} exceeds ${MAX_JSON_BYTES} bytes`);
  return text;
};
const decode = (text: unknown): unknown => { if (typeof text !== "string") return null; try { return JSON.parse(text); } catch { return null; } };
const isDuplicate = (error: unknown) => { const e = error as { code?: string; errno?: number; cause?: { code?: string; errno?: number } }; return e?.code === "ER_DUP_ENTRY" || e?.errno === 1062 || e?.cause?.code === "ER_DUP_ENTRY" || e?.cause?.errno === 1062; };
const isDeadlock = (error: unknown) => { const e = error as { code?: string; errno?: number; cause?: { code?: string; errno?: number } }; return [e?.code, e?.cause?.code].some(c => c === "ER_LOCK_DEADLOCK" || c === "ER_LOCK_WAIT_TIMEOUT") || [e?.errno, e?.cause?.errno].some(n => n === 1213 || n === 1205); };
/** InnoDB may pick a worker as a deadlock victim under heavy contention; the statement is safe to repeat (all transitions are conditional). */
async function withDeadlockRetry<T>(run: () => Promise<T>, attempts = 6): Promise<T> {
  for (let i = 1; ; i += 1) {
    try { return await run(); }
    catch (error) { if (!isDeadlock(error) || i >= attempts) throw error; await new Promise(r => setTimeout(r, 5 + Math.random() * 25 * i)); }
  }
}
export const hashInput = (type: string, input: unknown) => createHash("sha256").update(`${type}\n${JSON.stringify(input ?? null)}`).digest("hex");

type Row = Record<string, any>;
const date = (value: unknown) => (value ? new Date(value as string | number | Date) : null);
function toRecord(row: Row): TaskRecord {
  return {
    id: row.id, workspaceId: Number(row.workspaceId), createdByUserId: row.createdByUserId ?? null, type: row.type, state: row.state as TaskState,
    idempotencyKey: row.idempotencyKey ?? null, input: decode(row.inputJson), checkpoint: row.checkpointJson == null ? null : decode(row.checkpointJson), checkpointSeq: Number(row.checkpointSeq),
    progressPercent: row.progressPercent == null ? null : Number(row.progressPercent), progressNote: row.progressNote ?? null, result: row.resultJson == null ? null : decode(row.resultJson),
    attempt: Number(row.attempt), maxAttempts: Number(row.maxAttempts), retryAfter: date(row.retryAfter), leaseOwner: row.leaseOwner ?? null, leaseExpiresAt: date(row.leaseExpiresAt),
    cancelRequested: Boolean(Number(row.cancelRequested)), failureClass: (row.failureClass ?? null) as TaskFailureClass | null, errorMessage: row.errorMessage ?? null,
    createdAt: new Date(row.createdAt), updatedAt: new Date(row.updatedAt), startedAt: date(row.startedAt), finishedAt: date(row.finishedAt),
  };
}
export const toView = (t: TaskRecord): TaskView => ({ id: t.id, workspaceId: t.workspaceId, type: t.type, state: t.state, checkpointSeq: t.checkpointSeq, progressPercent: t.progressPercent, progressNote: t.progressNote, result: t.result, attempt: t.attempt, maxAttempts: t.maxAttempts, cancelRequested: t.cancelRequested, failureClass: t.failureClass, errorMessage: t.errorMessage, createdAt: t.createdAt, updatedAt: t.updatedAt, startedAt: t.startedAt, finishedAt: t.finishedAt });

export type CreateTaskInput = { workspaceId: number; type: string; input?: unknown; idempotencyKey?: string; maxAttempts?: number; createdByUserId?: number };
const microsOf = (ms: number) => Math.max(1, Math.floor(ms)) * 1000;

export class MysqlTaskStore {
  constructor(private readonly getDb: DbProvider) {}
  private async db(): Promise<Db> { const db = await this.getDb(); if (!db) throw new Error("database unavailable"); return db; }

  async create(input: CreateTaskInput): Promise<{ task: TaskRecord; created: boolean }> {
    if (!Number.isInteger(input.workspaceId) || input.workspaceId < 1) throw new Error("workspaceId required");
    if (!/^[a-z][a-z0-9._-]{0,95}$/i.test(input.type)) throw new Error("invalid task type");
    if (input.idempotencyKey !== undefined && !/^[\x21-\x7e]{1,128}$/.test(input.idempotencyKey)) throw new Error("invalid idempotency key");
    const maxAttempts = Math.min(10, Math.max(1, Math.floor(input.maxAttempts ?? 3)));
    const db = await this.db();
    const id = randomUUID();
    const inputHash = hashInput(input.type, input.input);
    try {
      await db.execute(sql`INSERT INTO durableTasks (id, workspaceId, createdByUserId, type, state, idempotencyKey, inputHash, inputJson, maxAttempts, createdAt, updatedAt)
        VALUES (${id}, ${input.workspaceId}, ${input.createdByUserId ?? null}, ${input.type}, 'QUEUED', ${input.idempotencyKey ?? null}, ${inputHash}, ${encode(input.input, "task input")}, ${maxAttempts}, NOW(3), NOW(3))`);
    } catch (error) {
      if (!isDuplicate(error) || input.idempotencyKey === undefined) throw error;
      const rows = rowsOf<Row>(await db.execute(sql`SELECT * FROM durableTasks WHERE workspaceId = ${input.workspaceId} AND idempotencyKey = ${input.idempotencyKey}`));
      if (!rows[0]) throw error;
      if (rows[0].inputHash !== inputHash || rows[0].type !== input.type) throw new TaskIdempotencyConflict();
      return { task: toRecord(rows[0]), created: false };
    }
    return { task: (await this.getInternal(id))!, created: true };
  }

  private async getInternal(id: string): Promise<TaskRecord | null> {
    const db = await this.db();
    const rows = rowsOf<Row>(await db.execute(sql`SELECT * FROM durableTasks WHERE id = ${id}`));
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /** Workspace-scoped read: another workspace's task is reported as absent. */
  async get(workspaceId: number, id: string): Promise<TaskRecord | null> {
    const db = await this.db();
    const rows = rowsOf<Row>(await db.execute(sql`SELECT * FROM durableTasks WHERE id = ${id} AND workspaceId = ${workspaceId}`));
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async list(workspaceId: number, options: { state?: TaskState; limit?: number } = {}): Promise<TaskRecord[]> {
    const db = await this.db();
    const limit = Math.min(200, Math.max(1, Math.floor(options.limit ?? 50)));
    const rows = options.state
      ? rowsOf<Row>(await db.execute(sql`SELECT * FROM durableTasks WHERE workspaceId = ${workspaceId} AND state = ${options.state} ORDER BY createdAt DESC, id LIMIT ${limit}`))
      : rowsOf<Row>(await db.execute(sql`SELECT * FROM durableTasks WHERE workspaceId = ${workspaceId} ORDER BY createdAt DESC, id LIMIT ${limit}`));
    return rows.map(toRecord);
  }

  /** Durable cancel. QUEUED/WAITING tasks are cancelled at once; RUNNING tasks get cancelRequested and stop at their next checkpoint. */
  async cancel(workspaceId: number, id: string): Promise<TaskRecord | null> {
    const db = await this.db();
    await db.execute(sql`UPDATE durableTasks SET state = 'CANCELLED', cancelRequested = 1, leaseOwner = NULL, leaseExpiresAt = NULL, finishedAt = NOW(3), updatedAt = NOW(3)
      WHERE id = ${id} AND workspaceId = ${workspaceId} AND state IN ('QUEUED','WAITING')`);
    await db.execute(sql`UPDATE durableTasks SET cancelRequested = 1, updatedAt = NOW(3) WHERE id = ${id} AND workspaceId = ${workspaceId} AND state = 'RUNNING'`);
    return this.get(workspaceId, id);
  }

  /** Housekeeping then claim: returns the claimed task (attempt already incremented) or null. */
  async claim(owner: string, options: { leaseMs: number; types?: readonly string[] }): Promise<TaskRecord | null> {
    const db = await this.db();
    const types = options.types?.length ? options.types : null;
    if (options.types && options.types.length === 0) return null;
    // Housekeeping touches rows by PRIMARY KEY only (candidates come from a non-locking read), so concurrent workers
    // never take overlapping range locks; a deadlock victim simply retries.
    const cancelOrphan = sql`cancelRequested = 1 AND ((state IN ('QUEUED','WAITING')) OR (state = 'RUNNING' AND leaseExpiresAt < NOW(3)))`;
    for (const row of rowsOf<{ id: string }>(await db.execute(sql`SELECT id FROM durableTasks WHERE ${cancelOrphan} LIMIT 50`))) {
      // 1) cancelled work whose worker is gone (or never started) is finalised, not run
      await withDeadlockRetry(() => db.execute(sql`UPDATE durableTasks SET state = 'CANCELLED', leaseOwner = NULL, leaseExpiresAt = NULL, finishedAt = NOW(3), updatedAt = NOW(3) WHERE id = ${row.id} AND ${cancelOrphan}`));
    }
    const exhausted = sql`state = 'RUNNING' AND leaseExpiresAt < NOW(3) AND attempt >= maxAttempts`;
    for (const row of rowsOf<{ id: string }>(await db.execute(sql`SELECT id FROM durableTasks WHERE ${exhausted} LIMIT 50`))) {
      // 2) a crashed worker never counts as success; out-of-attempts tasks fail visibly
      await withDeadlockRetry(() => db.execute(sql`UPDATE durableTasks SET state = 'FAILED', failureClass = 'LEASE_EXPIRED', errorMessage = 'worker lease expired and no attempts remain', leaseOwner = NULL, leaseExpiresAt = NULL, finishedAt = NOW(3), updatedAt = NOW(3) WHERE id = ${row.id} AND ${exhausted}`));
    }
    const eligible = sql`attempt < maxAttempts AND cancelRequested = 0 AND (state = 'QUEUED' OR (state = 'WAITING' AND retryAfter <= NOW(3)) OR (state = 'RUNNING' AND leaseExpiresAt < NOW(3)))`;
    const typeFilter = types ? sql` AND type IN (${sql.join(types.map(t => sql`${t}`), sql`, `)})` : sql``;
    const candidates = rowsOf<{ id: string }>(await db.execute(sql`SELECT id FROM durableTasks WHERE ${eligible}${typeFilter} ORDER BY createdAt, id LIMIT 10`));
    for (const candidate of candidates) {
      const result = await withDeadlockRetry(() => db.execute(sql`UPDATE durableTasks SET state = 'RUNNING', leaseOwner = ${owner}, leaseExpiresAt = DATE_ADD(NOW(3), INTERVAL ${microsOf(options.leaseMs)} MICROSECOND),
        attempt = attempt + 1, retryAfter = NULL, startedAt = COALESCE(startedAt, NOW(3)), updatedAt = NOW(3)
        WHERE id = ${candidate.id} AND ${eligible}`));
      if (affected(result) === 1) return this.getInternal(candidate.id);
    }
    return null;
  }

  private fence = (id: string, owner: string, attempt: number) => sql`id = ${id} AND leaseOwner = ${owner} AND attempt = ${attempt} AND state = 'RUNNING'`;

  async heartbeat(id: string, owner: string, attempt: number, leaseMs: number): Promise<{ ok: boolean; cancelRequested: boolean }> {
    const db = await this.db();
    const result = await db.execute(sql`UPDATE durableTasks SET leaseExpiresAt = DATE_ADD(NOW(3), INTERVAL ${microsOf(leaseMs)} MICROSECOND), updatedAt = NOW(3) WHERE ${this.fence(id, owner, attempt)}`);
    if (affected(result) !== 1) return { ok: false, cancelRequested: false };
    const rows = rowsOf<Row>(await db.execute(sql`SELECT cancelRequested FROM durableTasks WHERE id = ${id}`));
    return { ok: true, cancelRequested: Boolean(Number(rows[0]?.cancelRequested)) };
  }

  /** Durable checkpoint. `seq` must increase; returns ok=false if the lease was lost (the caller must stop). */
  async checkpoint(id: string, owner: string, attempt: number, input: { seq: number; data: unknown; progressPercent?: number; progressNote?: string; leaseMs: number }): Promise<{ ok: boolean; cancelRequested: boolean }> {
    const db = await this.db();
    const percent = input.progressPercent === undefined ? null : Math.min(100, Math.max(0, Math.floor(input.progressPercent)));
    const result = await db.execute(sql`UPDATE durableTasks SET checkpointJson = ${encode(input.data, "checkpoint")}, checkpointSeq = ${input.seq},
      progressPercent = COALESCE(${percent}, progressPercent), progressNote = COALESCE(${input.progressNote?.slice(0, 255) ?? null}, progressNote),
      leaseExpiresAt = DATE_ADD(NOW(3), INTERVAL ${microsOf(input.leaseMs)} MICROSECOND), updatedAt = NOW(3)
      WHERE ${this.fence(id, owner, attempt)} AND checkpointSeq < ${input.seq}`);
    if (affected(result) !== 1) return { ok: false, cancelRequested: false };
    const rows = rowsOf<Row>(await db.execute(sql`SELECT cancelRequested FROM durableTasks WHERE id = ${id}`));
    return { ok: true, cancelRequested: Boolean(Number(rows[0]?.cancelRequested)) };
  }

  async complete(id: string, owner: string, attempt: number, result: unknown): Promise<boolean> {
    const db = await this.db();
    const res = await db.execute(sql`UPDATE durableTasks SET state = 'SUCCEEDED', resultJson = ${encode(result, "result")}, progressPercent = 100, leaseOwner = NULL, leaseExpiresAt = NULL, finishedAt = NOW(3), updatedAt = NOW(3) WHERE ${this.fence(id, owner, attempt)}`);
    return affected(res) === 1;
  }

  /** Retryable failures below maxAttempts go back to WAITING with a backoff; everything else is a visible FAILED. */
  async fail(id: string, owner: string, attempt: number, failure: { failureClass: TaskFailureClass; message: string; retryable: boolean; backoffMs?: number }): Promise<"WAITING" | "FAILED" | "LOST"> {
    const db = await this.db();
    const message = failure.message.slice(0, 500);
    if (failure.retryable) {
      const retry = await db.execute(sql`UPDATE durableTasks SET state = 'WAITING', failureClass = ${failure.failureClass}, errorMessage = ${message}, retryAfter = DATE_ADD(NOW(3), INTERVAL ${microsOf(failure.backoffMs ?? 1000)} MICROSECOND),
        leaseOwner = NULL, leaseExpiresAt = NULL, updatedAt = NOW(3) WHERE ${this.fence(id, owner, attempt)} AND attempt < maxAttempts`);
      if (affected(retry) === 1) return "WAITING";
    }
    const done = await db.execute(sql`UPDATE durableTasks SET state = 'FAILED', failureClass = ${failure.failureClass}, errorMessage = ${message}, leaseOwner = NULL, leaseExpiresAt = NULL, finishedAt = NOW(3), updatedAt = NOW(3) WHERE ${this.fence(id, owner, attempt)}`);
    return affected(done) === 1 ? "FAILED" : "LOST";
  }

  async markCancelled(id: string, owner: string, attempt: number): Promise<boolean> {
    const db = await this.db();
    const res = await db.execute(sql`UPDATE durableTasks SET state = 'CANCELLED', leaseOwner = NULL, leaseExpiresAt = NULL, finishedAt = NOW(3), updatedAt = NOW(3) WHERE ${this.fence(id, owner, attempt)}`);
    return affected(res) === 1;
  }

  async getEffect(taskId: string, key: string): Promise<{ found: boolean; result: unknown }> {
    const db = await this.db();
    const rows = rowsOf<Row>(await db.execute(sql`SELECT resultJson FROM durableTaskEffects WHERE taskId = ${taskId} AND effectKey = ${key}`));
    return rows[0] ? { found: true, result: decode(rows[0].resultJson) } : { found: false, result: null };
  }
  async recordEffect(taskId: string, key: string, result: unknown): Promise<void> {
    const db = await this.db();
    await db.execute(sql`INSERT INTO durableTaskEffects (taskId, effectKey, resultJson, createdAt) VALUES (${taskId}, ${key}, ${encode(result, "effect result")}, NOW(3)) ON DUPLICATE KEY UPDATE taskId = taskId`);
  }
}
export const isTerminal = (state: TaskState) => TERMINAL_STATES.includes(state);
