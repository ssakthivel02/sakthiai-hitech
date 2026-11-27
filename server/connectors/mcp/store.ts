import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/mysql2";

type Db = ReturnType<typeof drizzle>;
export type DbProvider = () => Promise<Db | null | undefined>;
type Row = Record<string, any>;
const rowsOf = (result: unknown): Row[] => (Array.isArray(result) && Array.isArray(result[0]) ? (result[0] as Row[]) : []);
const isDuplicate = (error: unknown) => { const e = error as { code?: string; errno?: number; cause?: { code?: string; errno?: number } }; return e?.code === "ER_DUP_ENTRY" || e?.errno === 1062 || e?.cause?.code === "ER_DUP_ENTRY" || e?.cause?.errno === 1062; };

export type ConnectorRecord = {
  id: string; workspaceId: number; name: string; endpoint: string; enabled: boolean; secretRef: string | null;
  allowedTools: string[] | null; timeoutMs: number; maxResponseBytes: number; createdAt: Date; updatedAt: Date;
};
export type AuditAction = "REGISTER" | "ENABLE" | "DISABLE" | "REMOVE" | "DISCOVER" | "READ_RESOURCE" | "CALL_TOOL";
export type AuditOutcome = "OK" | "DENIED" | "ERROR" | "TIMEOUT" | "TOO_LARGE" | "INVALID";
export type AuditRecord = { id: number; workspaceId: number; connectorId: string; actorUserId: number | null; action: AuditAction; target: string | null; outcome: AuditOutcome; detail: string | null; responseBytes: number | null; createdAt: Date };

const toRecord = (r: Row): ConnectorRecord => {
  let allowed: string[] | null = null;
  try { const parsed = r.allowedToolsJson ? JSON.parse(r.allowedToolsJson) : null; allowed = Array.isArray(parsed) ? parsed.filter((v: unknown) => typeof v === "string") : null; } catch { allowed = null; }
  return { id: r.id, workspaceId: Number(r.workspaceId), name: r.name, endpoint: r.endpoint, enabled: Boolean(Number(r.enabled)), secretRef: r.secretRef ?? null, allowedTools: allowed, timeoutMs: Number(r.timeoutMs), maxResponseBytes: Number(r.maxResponseBytes), createdAt: new Date(r.createdAt), updatedAt: new Date(r.updatedAt) };
};

export class McpConnectorStore {
  constructor(private readonly getDb: DbProvider) {}
  private async db(): Promise<Db> { const db = await this.getDb(); if (!db) throw new Error("database unavailable"); return db; }

  async create(input: { workspaceId: number; name: string; endpoint: string; secretRef?: string; allowedTools?: string[]; timeoutMs: number; maxResponseBytes: number; createdByUserId?: number }): Promise<ConnectorRecord | "DUPLICATE_NAME"> {
    const db = await this.db(); const id = randomUUID();
    try {
      await db.execute(sql`INSERT INTO mcpConnectors (id, workspaceId, name, endpoint, enabled, secretRef, allowedToolsJson, timeoutMs, maxResponseBytes, createdByUserId, createdAt, updatedAt)
        VALUES (${id}, ${input.workspaceId}, ${input.name}, ${input.endpoint}, 0, ${input.secretRef ?? null}, ${input.allowedTools ? JSON.stringify(input.allowedTools) : null}, ${input.timeoutMs}, ${input.maxResponseBytes}, ${input.createdByUserId ?? null}, NOW(3), NOW(3))`);
    } catch (error) { if (isDuplicate(error)) return "DUPLICATE_NAME"; throw error; }
    return (await this.get(input.workspaceId, id))!;
  }
  async get(workspaceId: number, id: string): Promise<ConnectorRecord | null> {
    const rows = rowsOf(await (await this.db()).execute(sql`SELECT * FROM mcpConnectors WHERE id = ${id} AND workspaceId = ${workspaceId}`));
    return rows[0] ? toRecord(rows[0]) : null;
  }
  async list(workspaceId: number): Promise<ConnectorRecord[]> {
    return rowsOf(await (await this.db()).execute(sql`SELECT * FROM mcpConnectors WHERE workspaceId = ${workspaceId} ORDER BY name`)).map(toRecord);
  }
  async setEnabled(workspaceId: number, id: string, enabled: boolean): Promise<boolean> {
    const result = await (await this.db()).execute(sql`UPDATE mcpConnectors SET enabled = ${enabled ? 1 : 0}, updatedAt = NOW(3) WHERE id = ${id} AND workspaceId = ${workspaceId}`);
    return Number(((Array.isArray(result) ? result[0] : result) as { affectedRows?: number })?.affectedRows ?? 0) === 1;
  }
  async remove(workspaceId: number, id: string): Promise<boolean> {
    const result = await (await this.db()).execute(sql`DELETE FROM mcpConnectors WHERE id = ${id} AND workspaceId = ${workspaceId}`);
    return Number(((Array.isArray(result) ? result[0] : result) as { affectedRows?: number })?.affectedRows ?? 0) === 1;
  }
  async audit(entry: { workspaceId: number; connectorId: string; actorUserId?: number; action: AuditAction; target?: string; outcome: AuditOutcome; detail?: string; responseBytes?: number }): Promise<void> {
    await (await this.db()).execute(sql`INSERT INTO mcpConnectorAudit (workspaceId, connectorId, actorUserId, action, target, outcome, detail, responseBytes, createdAt)
      VALUES (${entry.workspaceId}, ${entry.connectorId}, ${entry.actorUserId ?? null}, ${entry.action}, ${entry.target?.slice(0, 255) ?? null}, ${entry.outcome}, ${entry.detail?.slice(0, 255) ?? null}, ${entry.responseBytes ?? null}, NOW(3))`);
  }
  async listAudit(workspaceId: number, limit = 100): Promise<AuditRecord[]> {
    return rowsOf(await (await this.db()).execute(sql`SELECT * FROM mcpConnectorAudit WHERE workspaceId = ${workspaceId} ORDER BY id DESC LIMIT ${Math.min(500, Math.max(1, limit))}`)).map(r => ({ id: Number(r.id), workspaceId: Number(r.workspaceId), connectorId: r.connectorId, actorUserId: r.actorUserId ?? null, action: r.action, target: r.target ?? null, outcome: r.outcome, detail: r.detail ?? null, responseBytes: r.responseBytes ?? null, createdAt: new Date(r.createdAt) }));
  }
}
