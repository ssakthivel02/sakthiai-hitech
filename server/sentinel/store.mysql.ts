import { sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/mysql2";
import { INVESTIGATION_STATUSES } from "./types";
import type { AuditAction, AuditEntry, DiagnosticBinding, InvestigationRecord, InvestigationStatus, ReadTool, Severity, StoredEvent } from "./types";
import type { Limits } from "./engine/types";
import type { FinalSummary } from "./replay";
import { SentinelConflictError, decodeCursor, encodeCursor, planAppend } from "./store";
import type { InvestigationPage, NewInvestigation, SentinelStore } from "./store";

type Db = ReturnType<typeof drizzle>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type DbProvider = () => Promise<Db | null | undefined>;
type Row = Record<string, any>;
const rowsOf = <T>(result: unknown): T[] => (Array.isArray(result) && Array.isArray(result[0]) ? (result[0] as T[]) : []);
const affected = (result: unknown): number => Number((((Array.isArray(result) ? result[0] : result) as { affectedRows?: number }) ?? {}).affectedRows ?? 0);
const date = (v: unknown): Date | null => (v ? new Date(v as string | number | Date) : null);
const MAX_EVENT_BYTES = 1_000_000;
const parseJson = <T>(text: unknown, fallback: T): T => { if (typeof text !== "string") return fallback; try { return JSON.parse(text) as T; } catch { return fallback; } };

interface Spec { operatorNotes: string[]; inventory: { services: string[]; hosts: string[] }; allowedTools: ReadTool[]; limits: Limits; bindings: DiagnosticBinding[] }

function toRecord(r: Row): InvestigationRecord {
  const spec = parseJson<Spec>(r.specJson, { operatorNotes: [], inventory: { services: [], hosts: [] }, allowedTools: [], limits: { max_tool_calls: 1, max_steps: 1, max_retries_per_call: 0, max_virtual_ms: 1 }, bindings: [] });
  const status = INVESTIGATION_STATUSES.includes(r.status) ? (r.status as InvestigationStatus) : "FAILED";
  return {
    id: r.id, workspaceId: Number(r.workspaceId), createdByUserId: Number(r.createdByUserId), taskId: r.taskId ?? null, title: r.title, severity: r.severity as Severity, service: r.service,
    firedAt: r.firedAt, description: r.description, objective: r.objective, operatorNotes: spec.operatorNotes, inventory: spec.inventory, allowedTools: spec.allowedTools, limits: spec.limits, bindings: spec.bindings,
    status, stopReason: r.stopReason ?? null, outcome: r.outcome ?? null, label: r.label ?? null, confidence: r.confidence == null ? null : Number(r.confidence),
    verified: r.verified == null ? null : Boolean(Number(r.verified)), traceHead: r.traceHead ?? null, eventCount: Number(r.eventCount ?? 0), errorMessage: r.errorMessage ?? null,
    createdAt: new Date(r.createdAt), updatedAt: new Date(r.updatedAt), startedAt: date(r.startedAt), finishedAt: date(r.finishedAt),
  };
}
const toEvent = (r: Row): StoredEvent => ({ seq: Number(r.seq), type: r.type, vt: Number(r.vt), payload: parseJson<unknown>(r.payloadJson, null), prev: r.prev, hash: r.hash });

/**
 * MySQL SentinelStore (raw SQL, same style as MysqlTaskStore). Tables are defined in drizzle/proposals/0014_sentinel_investigations.sql, which is a
 * PROPOSAL and is not part of the migration journal: nothing here runs until the owner applies it. Every query filters by workspaceId.
 */
export class MysqlSentinelStore implements SentinelStore {
  constructor(private readonly getDb: DbProvider) {}
  private async db(): Promise<Db> { const db = await this.getDb(); if (!db) throw new Error("database unavailable"); return db; }

  async create(i: NewInvestigation): Promise<InvestigationRecord> {
    const db = await this.db();
    const spec: Spec = { operatorNotes: i.operatorNotes, inventory: i.inventory, allowedTools: i.allowedTools, limits: i.limits, bindings: i.bindings };
    // Idempotent insert (no INSERT IGNORE: real errors such as truncation must still surface). A duplicate id is resolved below, workspace-scoped.
    await db.execute(sql`INSERT INTO sentinelInvestigations (id, workspaceId, createdByUserId, title, severity, service, firedAt, description, objective, specJson, status, eventCount, createdAt, updatedAt)
      VALUES (${i.id}, ${i.workspaceId}, ${i.createdByUserId}, ${i.title}, ${i.severity}, ${i.service}, ${i.firedAt}, ${i.description}, ${i.objective}, ${JSON.stringify(spec)}, 'QUEUED', 0, NOW(3), NOW(3))
      ON DUPLICATE KEY UPDATE id = id`);
    const got = await this.get(i.workspaceId, i.id);
    if (!got) throw new SentinelConflictError("investigation id already in use");   // exists, but in another workspace: do not reveal which
    return got;
  }
  async attachTask(workspaceId: number, id: string, taskId: string): Promise<boolean> {
    const db = await this.db();
    await db.execute(sql`UPDATE sentinelInvestigations SET taskId = ${taskId}, updatedAt = NOW(3) WHERE id = ${id} AND workspaceId = ${workspaceId} AND taskId IS NULL`);
    const row = rowsOf<Row>(await db.execute(sql`SELECT taskId FROM sentinelInvestigations WHERE id = ${id} AND workspaceId = ${workspaceId}`))[0];
    return !!row && row.taskId === taskId;
  }
  async get(workspaceId: number, id: string): Promise<InvestigationRecord | null> {
    const db = await this.db();
    const rows = rowsOf<Row>(await db.execute(sql`SELECT * FROM sentinelInvestigations WHERE id = ${id} AND workspaceId = ${workspaceId}`));
    return rows[0] ? toRecord(rows[0]) : null;
  }
  async list(workspaceId: number, opts: { limit?: number; status?: InvestigationStatus } = {}): Promise<InvestigationRecord[]> {
    return (await this.listPage(workspaceId, opts)).items;
  }
  async listPage(workspaceId: number, opts: { limit?: number; status?: InvestigationStatus; cursor?: string } = {}): Promise<InvestigationPage> {
    const db = await this.db();
    const limit = Math.min(200, Math.max(1, Math.floor(opts.limit ?? 50)));
    const cur = opts.cursor ? decodeCursor(opts.cursor) : null;
    const status = opts.status ? sql` AND status = ${opts.status}` : sql``;
    // Keyset on (createdAt DESC, id ASC). The cursor key is the raw datetime(3) text from the same server, so there is no timezone round-trip.
    const after = cur ? sql` AND (createdAt < ${cur.key} OR (createdAt = ${cur.key} AND id > ${cur.id}))` : sql``;
    const rows = rowsOf<Row>(await db.execute(sql`SELECT *, DATE_FORMAT(createdAt, '%Y-%m-%d %H:%i:%s.%f') AS createdAtKey FROM sentinelInvestigations WHERE workspaceId = ${workspaceId}${status}${after} ORDER BY createdAt DESC, id ASC LIMIT ${limit + 1}`));
    const page = rows.slice(0, limit); const last = page[page.length - 1];
    return { items: page.map(toRecord), nextCursor: rows.length > limit && last ? encodeCursor(String(last.createdAtKey), String(last.id)) : null };
  }
  async deleteTerminal(workspaceId: number, id: string): Promise<boolean> {
    const db = await this.db();
    return db.transaction(async (tx) => {
      const row = (await this.lockRow(tx, workspaceId, id));
      if (!row || !["COMPLETED", "ABSTAINED", "FAILED", "CANCELLED"].includes(row.status)) return false;
      await tx.execute(sql`DELETE FROM sentinelEvents WHERE investigationId = ${id} AND workspaceId = ${workspaceId}`);
      await tx.execute(sql`DELETE FROM sentinelInvestigations WHERE id = ${id} AND workspaceId = ${workspaceId}`);
      return true;   // sentinelAudit rows are deliberately retained
    });
  }
  private async lockRow(tx: Tx, workspaceId: number, id: string): Promise<Row | null> {
    return rowsOf<Row>(await tx.execute(sql`SELECT id, status, eventCount FROM sentinelInvestigations WHERE id = ${id} AND workspaceId = ${workspaceId} FOR UPDATE`))[0] ?? null;
  }
  async markRunning(workspaceId: number, id: string): Promise<void> {
    const db = await this.db();
    await db.execute(sql`UPDATE sentinelInvestigations SET status = 'RUNNING', startedAt = COALESCE(startedAt, NOW(3)), updatedAt = NOW(3) WHERE id = ${id} AND workspaceId = ${workspaceId} AND status = 'QUEUED'`);
  }
  async appendEvents(workspaceId: number, id: string, events: StoredEvent[]): Promise<void> {
    if (!events.length) return;
    const db = await this.db();
    // One transaction, serialised per investigation by a row lock: the continuity/fork check and the insert cannot interleave with another writer.
    await db.transaction(async (tx) => {
      if (!(await this.lockRow(tx, workspaceId, id))) throw new Error("investigation not found");
      const first = events[0]!.seq, last = events[events.length - 1]!.seq;
      const existing = rowsOf<Row>(await tx.execute(sql`SELECT seq, type, vt, payloadJson, prev, hash FROM sentinelEvents WHERE investigationId = ${id} AND workspaceId = ${workspaceId} AND seq >= ${Math.max(0, first - 1)} AND seq <= ${last} ORDER BY seq`)).map(toEvent);
      const add = planAppend(existing, events);
      if (add.length) {
        const tuples = add.map((e) => {
          const payload = JSON.stringify(e.payload ?? null);
          if (Buffer.byteLength(payload, "utf8") > MAX_EVENT_BYTES) throw new SentinelConflictError(`event ${e.seq} exceeds ${MAX_EVENT_BYTES} bytes`);
          return sql`(${id}, ${workspaceId}, ${e.seq}, ${e.type}, ${e.vt}, ${payload}, ${e.prev}, ${e.hash}, NOW(3))`;
        });
        await tx.execute(sql`INSERT INTO sentinelEvents (investigationId, workspaceId, seq, type, vt, payloadJson, prev, hash, createdAt) VALUES ${sql.join(tuples, sql`, `)}`);
      }
      // eventCount/traceHead always mirror what is actually stored (count is recomputed, never trusted from the caller)
      const tail = rowsOf<Row>(await tx.execute(sql`SELECT seq, hash FROM sentinelEvents WHERE investigationId = ${id} AND workspaceId = ${workspaceId} ORDER BY seq DESC LIMIT 1`))[0];
      if (tail) await tx.execute(sql`UPDATE sentinelInvestigations SET eventCount = ${Number(tail.seq) + 1}, traceHead = ${tail.hash}, updatedAt = NOW(3) WHERE id = ${id} AND workspaceId = ${workspaceId}`);
    });
  }
  async readEvents(workspaceId: number, id: string, opts: { fromSeq?: number; limit?: number } = {}): Promise<StoredEvent[]> {
    const db = await this.db();
    const from = Math.max(0, Math.floor(opts.fromSeq ?? 0)), limit = Math.min(5000, Math.max(1, Math.floor(opts.limit ?? 5000)));
    return rowsOf<Row>(await db.execute(sql`SELECT seq, type, vt, payloadJson, prev, hash FROM sentinelEvents WHERE investigationId = ${id} AND workspaceId = ${workspaceId} AND seq >= ${from} ORDER BY seq LIMIT ${limit}`)).map(toEvent);
  }
  async finalize(workspaceId: number, id: string, s: FinalSummary): Promise<void> {
    const db = await this.db();
    await db.transaction(async (tx) => {
      const row = await this.lockRow(tx, workspaceId, id);
      if (!row || !["QUEUED", "RUNNING"].includes(row.status)) return;          // missing/foreign or already terminal: no-op
      const tail = rowsOf<Row>(await tx.execute(sql`SELECT seq, hash FROM sentinelEvents WHERE investigationId = ${id} AND workspaceId = ${workspaceId} ORDER BY seq DESC LIMIT 1`))[0];
      const stored = tail ? Number(tail.seq) + 1 : 0;
      if (s.eventCount !== stored || (stored > 0 && s.traceHead !== tail!.hash)) throw new SentinelConflictError("finalize summary does not match the stored trace");
      await tx.execute(sql`UPDATE sentinelInvestigations SET status = ${s.status}, stopReason = ${s.stopReason}, outcome = ${s.outcome}, label = ${s.label}, confidence = ${s.confidence}, verified = ${s.verified ? 1 : 0},
        traceHead = ${s.traceHead}, eventCount = ${s.eventCount}, errorMessage = ${s.errorMessage?.slice(0, 500) ?? null}, finishedAt = NOW(3), updatedAt = NOW(3)
        WHERE id = ${id} AND workspaceId = ${workspaceId}`);
    });
  }
  async markCancelled(workspaceId: number, id: string): Promise<boolean> {
    const db = await this.db();
    return affected(await db.execute(sql`UPDATE sentinelInvestigations SET status = 'CANCELLED', stopReason = COALESCE(stopReason, 'CANCELLED_BEFORE_START'), finishedAt = NOW(3), updatedAt = NOW(3)
      WHERE id = ${id} AND workspaceId = ${workspaceId} AND status IN ('QUEUED','RUNNING')`)) > 0;
  }
  async recordAudit(e: { workspaceId: number; investigationId: string; actorUserId: number; action: AuditAction; detail?: string }): Promise<void> {
    const db = await this.db();
    await db.execute(sql`INSERT INTO sentinelAudit (investigationId, workspaceId, actorUserId, action, detail, createdAt) VALUES (${e.investigationId}, ${e.workspaceId}, ${e.actorUserId}, ${e.action}, ${e.detail?.slice(0, 500) ?? null}, NOW(3))`);
  }
  async listAudit(workspaceId: number, investigationId: string, limit = 100): Promise<AuditEntry[]> {
    const db = await this.db();
    const n = Math.min(500, Math.max(1, Math.floor(limit)));
    return rowsOf<Row>(await db.execute(sql`SELECT id, investigationId, workspaceId, actorUserId, action, detail, createdAt FROM sentinelAudit WHERE workspaceId = ${workspaceId} AND investigationId = ${investigationId} ORDER BY id DESC LIMIT ${n}`))
      .map((r) => ({ id: Number(r.id), investigationId: r.investigationId, workspaceId: Number(r.workspaceId), actorUserId: Number(r.actorUserId), action: r.action as AuditAction, detail: r.detail ?? null, createdAt: new Date(r.createdAt) }));
  }
}
