import { randomUUID } from "node:crypto";
import { isTerminalStatus } from "./types";
import type { AuditAction, AuditEntry, InvestigationRecord, InvestigationStatus, StoredEvent } from "./types";
import type { FinalSummary } from "./replay";
import { SentinelConflictError, decodeCursor, encodeCursor, planAppend } from "./store";
import type { InvestigationPage, NewInvestigation, SentinelStore } from "./store";

/** In-memory SentinelStore for tests. Same contract and workspace scoping as the MySQL store; not used in production. */
export class InMemorySentinelStore implements SentinelStore {
  readonly rows = new Map<string, InvestigationRecord>();
  readonly events = new Map<string, StoredEvent[]>();
  readonly audit: AuditEntry[] = [];
  private clock = 0;
  private now(): Date { return new Date(Date.UTC(2026, 0, 1) + (this.clock++) * 1000); }
  private own(workspaceId: number, id: string): InvestigationRecord | null { const r = this.rows.get(id); return r && r.workspaceId === workspaceId ? r : null; }

  async create(input: NewInvestigation): Promise<InvestigationRecord> {
    const id = input.id || randomUUID();
    const have = this.rows.get(id);
    if (have) { if (have.workspaceId !== input.workspaceId) throw new SentinelConflictError("investigation id already in use"); return structuredClone(have); }
    const t = this.now();
    const rec: InvestigationRecord = { ...structuredClone(input), id, taskId: null, status: "QUEUED", stopReason: null, outcome: null, label: null, confidence: null, verified: null, traceHead: null, eventCount: 0, errorMessage: null, createdAt: t, updatedAt: t, startedAt: null, finishedAt: null };
    this.rows.set(id, rec); this.events.set(id, []); return structuredClone(rec);
  }
  async attachTask(workspaceId: number, id: string, taskId: string): Promise<boolean> {
    const r = this.own(workspaceId, id); if (!r) return false;
    if (r.taskId && r.taskId !== taskId) return false;
    r.taskId = taskId; r.updatedAt = this.now(); return true;
  }
  async get(workspaceId: number, id: string): Promise<InvestigationRecord | null> { const r = this.own(workspaceId, id); return r ? structuredClone(r) : null; }
  async list(workspaceId: number, opts: { limit?: number; status?: InvestigationStatus } = {}): Promise<InvestigationRecord[]> {
    return [...this.rows.values()].filter((r) => r.workspaceId === workspaceId && (!opts.status || r.status === opts.status))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? -1 : 1)).slice(0, Math.min(200, Math.max(1, opts.limit ?? 50))).map((r) => structuredClone(r));
  }
  async listPage(workspaceId: number, opts: { limit?: number; status?: InvestigationStatus; cursor?: string } = {}): Promise<InvestigationPage> {
    const limit = Math.min(200, Math.max(1, Math.floor(opts.limit ?? 50)));
    const cur = opts.cursor ? decodeCursor(opts.cursor) : null;
    const all = [...this.rows.values()].filter((r) => r.workspaceId === workspaceId && (!opts.status || r.status === opts.status))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .filter((r) => !cur || r.createdAt.getTime() < Number(cur.key) || (r.createdAt.getTime() === Number(cur.key) && r.id > cur.id));
    const items = all.slice(0, limit); const last = items[items.length - 1];
    return { items: items.map((r) => structuredClone(r)), nextCursor: all.length > limit && last ? encodeCursor(String(last.createdAt.getTime()), last.id) : null };
  }
  async deleteTerminal(workspaceId: number, id: string): Promise<boolean> {
    const r = this.own(workspaceId, id); if (!r || !isTerminalStatus(r.status)) return false;
    this.rows.delete(id); this.events.delete(id); return true;
  }
  async markRunning(workspaceId: number, id: string): Promise<void> { const r = this.own(workspaceId, id); if (r && r.status === "QUEUED") { r.status = "RUNNING"; r.startedAt = r.startedAt ?? this.now(); r.updatedAt = this.now(); } }
  async appendEvents(workspaceId: number, id: string, events: StoredEvent[]): Promise<void> {
    const r = this.own(workspaceId, id); if (!r) throw new Error("investigation not found");
    const list = this.events.get(id)!; const add = planAppend(list, events);
    for (const e of add) list.push(structuredClone(e));
    r.eventCount = list.length; r.traceHead = list.length ? list[list.length - 1]!.hash : null; r.updatedAt = this.now();
  }
  async readEvents(workspaceId: number, id: string, opts: { fromSeq?: number; limit?: number } = {}): Promise<StoredEvent[]> {
    if (!this.own(workspaceId, id)) return [];
    return this.events.get(id)!.filter((e) => e.seq >= (opts.fromSeq ?? 0)).slice(0, opts.limit ?? 5000).map((e) => structuredClone(e));
  }
  async finalize(workspaceId: number, id: string, s: FinalSummary): Promise<void> {
    const r = this.own(workspaceId, id); if (!r || isTerminalStatus(r.status)) return;
    const list = this.events.get(id)!;
    if (s.eventCount !== list.length || (list.length > 0 && s.traceHead !== list[list.length - 1]!.hash)) throw new SentinelConflictError("finalize summary does not match the stored trace");
    Object.assign(r, { status: s.status, stopReason: s.stopReason, outcome: s.outcome, label: s.label, confidence: s.confidence, verified: s.verified, traceHead: s.traceHead, eventCount: s.eventCount, errorMessage: s.errorMessage, finishedAt: this.now(), updatedAt: this.now() });
  }
  async markCancelled(workspaceId: number, id: string): Promise<boolean> {
    const r = this.own(workspaceId, id); if (!r || isTerminalStatus(r.status)) return false;
    r.status = "CANCELLED"; r.stopReason = r.stopReason ?? "CANCELLED_BEFORE_START"; r.finishedAt = this.now(); r.updatedAt = this.now(); return true;
  }
  async recordAudit(e: { workspaceId: number; investigationId: string; actorUserId: number; action: AuditAction; detail?: string }): Promise<void> {
    // audit rows outlive a deleted investigation (accountability), so the DELETE entry may be written after the row is gone
    if (e.action !== "DELETE" && !this.own(e.workspaceId, e.investigationId)) throw new Error("investigation not found");
    this.audit.push({ id: this.audit.length + 1, investigationId: e.investigationId, workspaceId: e.workspaceId, actorUserId: e.actorUserId, action: e.action, detail: e.detail ?? null, createdAt: this.now() });
  }
  async listAudit(workspaceId: number, investigationId: string, limit = 100): Promise<AuditEntry[]> {
    return this.audit.filter((a) => a.workspaceId === workspaceId && a.investigationId === investigationId).slice(-limit).map((a) => structuredClone(a));
  }
}
