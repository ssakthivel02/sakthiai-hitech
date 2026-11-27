import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDatabase, skipMysqlSuite, type TestDatabase } from "../testing/mysqlTestDb";
import { UploadStore } from "./store";
import { UploadCleanupRunner, type CleanupConfig } from "./cleanupRunner";

describe.skipIf(skipMysqlSuite())("upload cleanup on real SQL", { timeout: 30_000 }, () => {
  let database: TestDatabase; let store: UploadStore;
  const rows = async <T = Record<string, any>>(q: ReturnType<typeof sql>) => ((await database.db.execute(q)) as unknown as [T[]])[0];
  const count = async (table: string, where = "1=1") => Number((await rows<{ n: number }>(sql.raw(`SELECT COUNT(*) n FROM ${table} WHERE ${where}`)))[0].n);
  let seq = 0; const uid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
  const session = async (state: string, opts: { expired?: boolean; ageDays?: number; staleMinutes?: number; chunks?: number } = {}) => {
    const id = uid();
    await database.db.execute(sql`INSERT INTO fileUploadSessions (id, workspaceId, userId, filename, mimeType, declaredBytes, declaredSha256, chunkSize, totalChunks, state, createdAt, updatedAt, expiresAt) VALUES (${id}, 1, 1, 'f.txt', 'text/plain', 10, ${"a".repeat(64)}, 4096, 2, ${state}, NOW(3), DATE_SUB(NOW(3), INTERVAL ${(opts.ageDays ?? 0) * 1440 + (opts.staleMinutes ?? 0)} MINUTE), ${opts.expired ? sql`DATE_SUB(NOW(3), INTERVAL 1 HOUR)` : sql`DATE_ADD(NOW(3), INTERVAL 1 HOUR)`})`);
    for (let i = 0; i < (opts.chunks ?? 1); i++) await database.db.execute(sql`INSERT INTO fileUploadChunks (uploadId, chunkIndex, bytes, sha256, data) VALUES (${id}, ${i}, 1, ${"b".repeat(64)}, ${Buffer.from("x")})`);
    return id;
  };
  const stateOf = async (id: string) => (await rows<{ state: string }>(sql`SELECT state FROM fileUploadSessions WHERE id = ${id}`))[0]?.state;
  const chunksOf = async (id: string) => count("fileUploadChunks", `uploadId = '${id}'`);
  const cfg: CleanupConfig = { enabled: true, intervalMs: 60_000, batchLimit: 2, maxBatchesPerRun: 20, retentionDays: 7, finalizingStaleSeconds: 300 };

  beforeAll(async () => { database = await createTestDatabase(); store = new UploadStore(async () => database.db); });
  afterAll(async () => { await database?.close(); });

  it("expires/recovers/purges terminal quarantine bytes, never touches live uploads or normal storage; bounded runs converge", async () => {
    await database.db.execute(sql`INSERT INTO documents (workspaceId, filename, mimeType, extractedText, contentHash) VALUES (1, 'keep.txt', 'text/plain', 'kept', 'hk')`);
    await database.db.execute(sql`INSERT INTO documentChunks (documentId, workspaceId, chunkIndex, content) VALUES (1, 1, 0, 'kept')`);
    const live = await session("OPEN", { chunks: 3 });
    const finalizingFresh = await session("FINALIZING", { chunks: 2 });
    const finalizingDead = await session("FINALIZING", { staleMinutes: 30, chunks: 2 });
    const staleOpen = [await session("OPEN", { expired: true, chunks: 2 }), await session("OPEN", { expired: true, chunks: 2 }), await session("OPEN", { expired: true, chunks: 2 })];
    const terminal = [await session("REJECTED", { chunks: 2 }), await session("COMPLETED", { chunks: 2 }), await session("ABORTED", { chunks: 2 })];
    const orphans = [uid(), uid(), uid()];
    for (const o of orphans) await database.db.execute(sql`INSERT INTO fileUploadChunks (uploadId, chunkIndex, bytes, sha256, data) VALUES (${o}, 0, 1, ${"c".repeat(64)}, ${Buffer.from("x")})`);
    const old = await session("COMPLETED", { ageDays: 30, chunks: 0 });

    const runner = new UploadCleanupRunner({ store, config: cfg });
    const first = await runner.runOnce();
    expect(first).toMatchObject({ status: "ran" }); expect((first as any).batches).toBeGreaterThan(1); // batchLimit 2 forced several bounded passes
    expect(runner.status().totals.purgedChunkRows).toBeGreaterThanOrEqual(terminal.length * 2 + orphans.length);

    // live / fresh-finalizing uploads are untouched, chunks included
    expect(await stateOf(live)).toBe("OPEN"); expect(await chunksOf(live)).toBe(3);
    expect(await stateOf(finalizingFresh)).toBe("FINALIZING"); expect(await chunksOf(finalizingFresh)).toBe(2);
    // dead finalizer recovered to OPEN with bytes preserved (retryable finalize)
    expect(await stateOf(finalizingDead)).toBe("OPEN"); expect(await chunksOf(finalizingDead)).toBe(2);
    // expired and terminal sessions have no quarantine bytes left; orphans purged
    for (const id of [...staleOpen, ...terminal]) expect(await chunksOf(id)).toBe(0);
    for (const id of staleOpen) expect(await stateOf(id)).toBe("EXPIRED");
    for (const o of orphans) expect(await chunksOf(o)).toBe(0);
    // retention: old terminal row forgotten, recent terminal rows kept for status lookups
    expect(await stateOf(old)).toBeUndefined(); expect(await stateOf(terminal[0])).toBe("REJECTED");
    // normal storage never touched
    expect(await count("documents")).toBe(1); expect(await count("documentChunks")).toBe(1);
    // idempotent: second run does nothing destructive
    const again = await runner.runOnce(); expect(again).toMatchObject({ status: "ran", truncated: false });
    expect(await chunksOf(live)).toBe(3);
  });

  it("a single bounded pass reports truncated when more work remains, and leaves the rest for later", async () => {
    const ids = [await session("REJECTED", { chunks: 1 }), await session("REJECTED", { chunks: 1 }), await session("REJECTED", { chunks: 1 }), await session("REJECTED", { chunks: 1 })];
    const r = await store.cleanup({ batchLimit: 2 });
    expect(r.truncated).toBe(true); expect(r.purgedChunkRows).toBe(2);
    const left = (await Promise.all(ids.map(chunksOf))).reduce((a, b) => a + b, 0); expect(left).toBe(2);
    const r2 = await store.cleanup({ batchLimit: 2 }); expect(r2.purgedChunkRows).toBe(2);
    expect((await Promise.all(ids.map(chunksOf))).reduce((a, b) => a + b, 0)).toBe(0);
  });

  it("two runners on the same database cannot corrupt each other (idempotent statements)", async () => {
    const ids = await Promise.all([1, 2, 3, 4, 5, 6].map(() => session("EXPIRED", { chunks: 2 })));
    const a = new UploadCleanupRunner({ store, config: cfg }); const b = new UploadCleanupRunner({ store: new UploadStore(async () => database.db), config: cfg });
    const [ra, rb] = await Promise.all([a.runOnce(), b.runOnce()]);
    expect([ra.status, rb.status]).toEqual(["ran", "ran"]);
    for (const id of ids) expect(await chunksOf(id)).toBe(0);
  });
});
