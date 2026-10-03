import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/mysql2";

type Db = ReturnType<typeof drizzle>;
export type DbProvider = () => Promise<Db | null | undefined>;
export type UploadState = "OPEN" | "FINALIZING" | "COMPLETED" | "REJECTED" | "EXPIRED" | "ABORTED";
export type UploadSession = {
  id: string; workspaceId: number; userId: number; projectId: number | null; filename: string; mimeType: string;
  declaredBytes: number; declaredSha256: string; chunkSize: number; totalChunks: number; state: UploadState;
  rejectReason: string | null; lastError: string | null; scanStatus: string | null; scanEngine: string | null; documentId: number | null;
  createdAt: Date; expiresAt: Date;
};
export type NewUpload = Pick<UploadSession, "workspaceId" | "userId" | "projectId" | "filename" | "mimeType" | "declaredBytes" | "declaredSha256" | "chunkSize" | "totalChunks">;
type Header = { affectedRows?: number };
const affected = (result: unknown) => Number(((Array.isArray(result) ? result[0] : result) as Header)?.affectedRows ?? 0);
const rowsOf = <T>(result: unknown): T[] => (Array.isArray(result) && Array.isArray(result[0]) ? (result[0] as T[]) : []);
const isDuplicate = (error: unknown) => { const e = error as { code?: string; errno?: number; cause?: { code?: string; errno?: number } }; return e?.code === "ER_DUP_ENTRY" || e?.errno === 1062 || e?.cause?.code === "ER_DUP_ENTRY" || e?.cause?.errno === 1062; };
const toSession = (r: Record<string, any>): UploadSession => ({
  id: r.id, workspaceId: Number(r.workspaceId), userId: Number(r.userId), projectId: r.projectId == null ? null : Number(r.projectId), filename: r.filename, mimeType: r.mimeType,
  declaredBytes: Number(r.declaredBytes), declaredSha256: r.declaredSha256, chunkSize: Number(r.chunkSize), totalChunks: Number(r.totalChunks), state: r.state,
  rejectReason: r.rejectReason ?? null, lastError: r.lastError ?? null, scanStatus: r.scanStatus ?? null, scanEngine: r.scanEngine ?? null, documentId: r.documentId == null ? null : Number(r.documentId),
  createdAt: new Date(r.createdAt), expiresAt: new Date(r.expiresAt),
});

/**
 * Quarantine store. Raw upload bytes exist ONLY in `fileUploadChunks`, a table nothing in retrieval, search, documents or
 * object storage reads. Every state change is one conditional UPDATE; every read is scoped by (workspaceId, userId).
 * Time comes from the database clock.
 */
export class UploadStore {
  constructor(private readonly getDb: DbProvider) {}
  private async db(): Promise<Db> { const db = await this.getDb(); if (!db) throw new Error("database unavailable"); return db; }

  async create(input: NewUpload, ttlSeconds: number): Promise<UploadSession> {
    const db = await this.db(); const id = randomUUID();
    await db.execute(sql`INSERT INTO fileUploadSessions (id, workspaceId, userId, projectId, filename, mimeType, declaredBytes, declaredSha256, chunkSize, totalChunks, state, createdAt, updatedAt, expiresAt)
      VALUES (${id}, ${input.workspaceId}, ${input.userId}, ${input.projectId}, ${input.filename}, ${input.mimeType}, ${input.declaredBytes}, ${input.declaredSha256}, ${input.chunkSize}, ${input.totalChunks}, 'OPEN', NOW(3), NOW(3), DATE_ADD(NOW(3), INTERVAL ${ttlSeconds} SECOND))`);
    return (await this.get(input.workspaceId, input.userId, id))!;
  }
  /** Scoped lookup: another workspace's or user's session is indistinguishable from absent. */
  async get(workspaceId: number, userId: number, id: string): Promise<UploadSession | null> {
    const db = await this.db();
    const rows = rowsOf<Record<string, any>>(await db.execute(sql`SELECT * FROM fileUploadSessions WHERE id = ${id} AND workspaceId = ${workspaceId} AND userId = ${userId} LIMIT 1`));
    return rows[0] ? toSession(rows[0]) : null;
  }
  async countActive(workspaceId: number, userId: number): Promise<{ sessions: number; bytes: number }> {
    const db = await this.db();
    const r = rowsOf<{ n: number; b: number | null }>(await db.execute(sql`SELECT COUNT(*) AS n, COALESCE(SUM(declaredBytes),0) AS b FROM fileUploadSessions WHERE workspaceId = ${workspaceId} AND userId = ${userId} AND state IN ('OPEN','FINALIZING') AND expiresAt > NOW(3)`));
    return { sessions: Number(r[0]?.n ?? 0), bytes: Number(r[0]?.b ?? 0) };
  }
  /** Idempotent put: same (index, sha) -> "stored"/"duplicate"; same index with different content -> "conflict". Only while OPEN and unexpired. */
  async putChunk(s: UploadSession, index: number, sha256: string, data: Buffer): Promise<"stored" | "duplicate" | "conflict" | "closed"> {
    const db = await this.db();
    const open = rowsOf<{ id: string }>(await db.execute(sql`SELECT id FROM fileUploadSessions WHERE id = ${s.id} AND workspaceId = ${s.workspaceId} AND userId = ${s.userId} AND state = 'OPEN' AND expiresAt > NOW(3) LIMIT 1`));
    if (!open[0]) return "closed";
    try {
      await db.execute(sql`INSERT INTO fileUploadChunks (uploadId, chunkIndex, bytes, sha256, data) VALUES (${s.id}, ${index}, ${data.length}, ${sha256}, ${data})`);
    } catch (error) {
      if (!isDuplicate(error)) throw error;
      const existing = rowsOf<{ sha256: string }>(await db.execute(sql`SELECT sha256 FROM fileUploadChunks WHERE uploadId = ${s.id} AND chunkIndex = ${index}`));
      return existing[0]?.sha256 === sha256 ? "duplicate" : "conflict";
    }
    await db.execute(sql`UPDATE fileUploadSessions SET updatedAt = NOW(3) WHERE id = ${s.id} AND state = 'OPEN'`);
    // Re-check: if the session was closed (finalize/abort/expiry) while the chunk was being written, discard it again.
    const still = rowsOf<{ id: string }>(await db.execute(sql`SELECT id FROM fileUploadSessions WHERE id = ${s.id} AND state = 'OPEN' LIMIT 1`));
    if (!still[0]) { await db.execute(sql`DELETE FROM fileUploadChunks WHERE uploadId = ${s.id} AND chunkIndex = ${index}`); return "closed"; }
    return "stored";
  }
  async receivedIndexes(id: string): Promise<number[]> {
    const db = await this.db();
    return rowsOf<{ chunkIndex: number }>(await db.execute(sql`SELECT chunkIndex FROM fileUploadChunks WHERE uploadId = ${id} ORDER BY chunkIndex`)).map(r => Number(r.chunkIndex));
  }
  async chunkMeta(id: string): Promise<Array<{ chunkIndex: number; bytes: number; sha256: string }>> {
    const db = await this.db();
    return rowsOf<Record<string, any>>(await db.execute(sql`SELECT chunkIndex, bytes, sha256 FROM fileUploadChunks WHERE uploadId = ${id} ORDER BY chunkIndex`)).map(r => ({ chunkIndex: Number(r.chunkIndex), bytes: Number(r.bytes), sha256: r.sha256 }));
  }
  async readChunk(id: string, index: number): Promise<Buffer | null> {
    const db = await this.db();
    const r = rowsOf<{ data: Buffer }>(await db.execute(sql`SELECT data FROM fileUploadChunks WHERE uploadId = ${id} AND chunkIndex = ${index}`));
    return r[0] ? Buffer.from(r[0].data) : null;
  }
  /** OPEN -> FINALIZING; exactly one concurrent finalizer wins. */
  async beginFinalize(s: UploadSession): Promise<boolean> {
    const db = await this.db();
    return affected(await db.execute(sql`UPDATE fileUploadSessions SET state = 'FINALIZING', updatedAt = NOW(3), lastError = NULL WHERE id = ${s.id} AND workspaceId = ${s.workspaceId} AND userId = ${s.userId} AND state = 'OPEN' AND expiresAt > NOW(3)`)) === 1;
  }
  /** Scanner/infra problem: the staged bytes stay quarantined and the upload can be finalized again. */
  async backToOpen(id: string, lastError: string, scan?: { status: string; engine: string }): Promise<void> {
    const db = await this.db();
    await db.execute(sql`UPDATE fileUploadSessions SET state = 'OPEN', lastError = ${lastError.slice(0, 160)}, scanStatus = ${scan?.status ?? null}, scanEngine = ${scan?.engine?.slice(0, 32) ?? null}, updatedAt = NOW(3) WHERE id = ${id} AND state = 'FINALIZING'`);
  }
  /** Terminal rejection: state change and chunk purge. */
  async reject(id: string, reason: string, scan?: { status: string; engine: string }): Promise<void> {
    const db = await this.db();
    await db.execute(sql`UPDATE fileUploadSessions SET state = 'REJECTED', rejectReason = ${reason.slice(0, 64)}, scanStatus = ${scan?.status ?? null}, scanEngine = ${scan?.engine?.slice(0, 32) ?? null}, updatedAt = NOW(3) WHERE id = ${id} AND state IN ('OPEN','FINALIZING')`);
    await this.purge(id);
  }
  async complete(id: string, documentId: number, scan: { status: string; engine: string }): Promise<void> {
    const db = await this.db();
    await db.execute(sql`UPDATE fileUploadSessions SET state = 'COMPLETED', documentId = ${documentId}, scanStatus = ${scan.status}, scanEngine = ${scan.engine.slice(0, 32)}, updatedAt = NOW(3) WHERE id = ${id} AND state = 'FINALIZING'`);
    await this.purge(id);
  }
  async abort(s: UploadSession): Promise<boolean> {
    const db = await this.db();
    const ok = affected(await db.execute(sql`UPDATE fileUploadSessions SET state = 'ABORTED', updatedAt = NOW(3) WHERE id = ${s.id} AND workspaceId = ${s.workspaceId} AND userId = ${s.userId} AND state = 'OPEN'`)) === 1;
    if (ok) await this.purge(s.id);
    return ok;
  }
  async purge(id: string): Promise<void> {
    const db = await this.db();
    await db.execute(sql`DELETE FROM fileUploadChunks WHERE uploadId = ${id}`);
  }
  /**
   * Housekeeping: expire stale OPEN sessions, recover FINALIZING sessions whose finalizer died, purge chunks of any terminal
   * session, and forget terminal session rows after retention. Never touches live OPEN/FINALIZING sessions.
   */
  async cleanup(opts: { finalizingStaleSeconds?: number; retentionDays?: number } = {}): Promise<{ expired: number; recovered: number; purgedChunkRows: number; deletedSessions: number }> {
    const db = await this.db(); const stale = opts.finalizingStaleSeconds ?? 300; const days = opts.retentionDays ?? 7;
    const expired = affected(await db.execute(sql`UPDATE fileUploadSessions SET state = 'EXPIRED', updatedAt = NOW(3) WHERE state = 'OPEN' AND expiresAt < NOW(3)`));
    const recovered = affected(await db.execute(sql`UPDATE fileUploadSessions SET state = 'OPEN', lastError = 'finalize_interrupted', updatedAt = NOW(3) WHERE state = 'FINALIZING' AND updatedAt < DATE_SUB(NOW(3), INTERVAL ${stale} SECOND)`));
    const purgedChunkRows = affected(await db.execute(sql`DELETE c FROM fileUploadChunks c JOIN fileUploadSessions s ON s.id = c.uploadId WHERE s.state IN ('COMPLETED','REJECTED','EXPIRED','ABORTED')`))
      + affected(await db.execute(sql`DELETE c FROM fileUploadChunks c LEFT JOIN fileUploadSessions s ON s.id = c.uploadId WHERE s.id IS NULL`));
    const deletedSessions = affected(await db.execute(sql`DELETE FROM fileUploadSessions WHERE state IN ('COMPLETED','REJECTED','EXPIRED','ABORTED') AND updatedAt < DATE_SUB(NOW(3), INTERVAL ${days} DAY)`));
    return { expired, recovered, purgedChunkRows, deletedSessions };
  }
}
