import type { AuditAction, AuditEntry, InvestigationRecord, InvestigationStatus, StoredEvent } from "./types";
import type { FinalSummary } from "./replay";

export type NewInvestigation = Omit<InvestigationRecord, "taskId" | "status" | "stopReason" | "outcome" | "label" | "confidence" | "verified" | "traceHead" | "eventCount" | "errorMessage" | "createdAt" | "updatedAt" | "startedAt" | "finishedAt">;

export interface InvestigationPage { items: InvestigationRecord[]; /** opaque keyset cursor for the next page, or null at the end */ nextCursor: string | null }
export const MAX_PAGE = 200;
/** A cursor is (sort key, id). The key is store-defined (in-memory: epoch ms; MySQL: the raw datetime(3) text) so no timezone conversion is ever involved. */
const encodeCursor = (key: string, id: string): string => Buffer.from(`${key}|${id}`, "utf8").toString("base64url");
/** Cursors are opaque to clients but decoded defensively: a malformed one is a conflict error, never an unscoped query. */
export function decodeCursor(cursor: string): { key: string; id: string } {
  const [key, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  if (!key || !id || !/^[0-9a-f-]{36}$/i.test(id) || !/^(\d{1,15}|\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d{1,6})?)$/.test(key)) throw new SentinelConflictError("invalid cursor");
  return { key, id };
}
export { encodeCursor };

export class SentinelConflictError extends Error { constructor(detail: string) { super(`SENTINEL_EVENT_CONFLICT: ${detail}`); this.name = "SentinelConflictError"; } }

/**
 * Persistence port. Every method is workspace-scoped: a row belonging to another workspace is indistinguishable from a missing row.
 * Implementations: MysqlSentinelStore (production, store.mysql.ts) and InMemorySentinelStore (tests).
 */
export interface SentinelStore {
  /** Idempotent on (id): creating an id that already exists in the SAME workspace returns the stored row unchanged; an id owned by another workspace throws SentinelConflictError (never reveals the owner). */
  create(input: NewInvestigation): Promise<InvestigationRecord>;
  /** Bind the durable task. Succeeds once: returns false (and changes nothing) if a different task is already attached or the row is missing. Re-attaching the same task is a no-op returning true. */
  attachTask(workspaceId: number, id: string, taskId: string): Promise<boolean>;
  get(workspaceId: number, id: string): Promise<InvestigationRecord | null>;
  list(workspaceId: number, opts?: { limit?: number; status?: InvestigationStatus }): Promise<InvestigationRecord[]>;
  /** Keyset-paginated history (createdAt DESC, id ASC). */
  listPage(workspaceId: number, opts?: { limit?: number; status?: InvestigationStatus; cursor?: string }): Promise<InvestigationPage>;
  /** Delete a TERMINAL investigation and its events. Audit rows are retained (accountability) and a DELETE audit entry should be recorded by the caller. Returns false if missing, foreign, or not terminal. */
  deleteTerminal(workspaceId: number, id: string): Promise<boolean>;
  /** QUEUED -> RUNNING (no-op in any other status) */ markRunning(workspaceId: number, id: string): Promise<void>;
  /** Append events. Idempotent: events already stored with an identical hash are skipped; a different hash at a stored seq, or a gap, throws SentinelConflictError. */
  appendEvents(workspaceId: number, id: string, events: StoredEvent[]): Promise<void>;
  readEvents(workspaceId: number, id: string, opts?: { fromSeq?: number; limit?: number }): Promise<StoredEvent[]>;
  /** Write the derived summary and terminal status. No-op if the row is already terminal. Throws SentinelConflictError if the summary's eventCount/traceHead do not match the stored trace (consistency guard). */
  finalize(workspaceId: number, id: string, summary: FinalSummary): Promise<void>;
  /** Mark a non-terminal row CANCELLED (queued task cancelled before it ever ran). */
  markCancelled(workspaceId: number, id: string): Promise<boolean>;
  recordAudit(entry: { workspaceId: number; investigationId: string; actorUserId: number; action: AuditAction; detail?: string }): Promise<void>;
  listAudit(workspaceId: number, investigationId: string, limit?: number): Promise<AuditEntry[]>;
}

/** Shared append planning: decides which of `events` still need inserting, enforcing continuity and rejecting forks. */
export function planAppend(stored: StoredEvent[], events: StoredEvent[]): StoredEvent[] {
  if (!events.length) return [];
  const bySeq = new Map(stored.map((e) => [e.seq, e]));
  const out: StoredEvent[] = [];
  let expectPrev: string | null = null;
  const first = events[0]!;
  if (first.seq > 0) {
    const before = bySeq.get(first.seq - 1);
    if (!before) throw new SentinelConflictError(`gap before seq ${first.seq}`);
    expectPrev = before.hash;
  }
  for (const [i, e] of events.entries()) {
    if (e.seq !== first.seq + i) throw new SentinelConflictError(`non-contiguous batch at ${e.seq}`);
    const have = bySeq.get(e.seq);
    if (have) { if (have.hash !== e.hash) throw new SentinelConflictError(`fork at seq ${e.seq}`); expectPrev = have.hash; continue; }
    if (expectPrev !== null && e.prev !== expectPrev) throw new SentinelConflictError(`broken link at seq ${e.seq}`);
    expectPrev = e.hash; out.push(e);
  }
  return out;
}
