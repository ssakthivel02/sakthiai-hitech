import { createHash } from "node:crypto";
import type { Request } from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDatabase, skipMysqlSuite, type TestDatabase } from "../testing/mysqlTestDb";
import { startFakeClamd } from "../testing/fakeClamd";
import type { MalwareScanner, MalwareScanResult } from "../security/malwareScanner";

const storageState = vi.hoisted(() => ({ puts: [] as string[], failNext: 0 }));
vi.mock("../storage", () => ({
  storagePut: vi.fn(async (relKey: string) => { if (storageState.failNext > 0) { storageState.failNext -= 1; throw new Error("object store down"); } const key = `${relKey}-${storageState.puts.length}`; storageState.puts.push(key); return { key, url: `/storage/${key}` }; }),
}));
vi.mock("../creator/router", async () => { const { router } = await import("../_core/trpc"); return { creatorRouter: router({}) }; });

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const TXT = "முருகன் கோவில் பழநியில் உள்ளது. The Murugan temple opens at 6am.\n".repeat(400); // ~ 30KB multi-chunk
const CHUNK = 4096;

describe.skipIf(skipMysqlSuite())("resumable quarantined ingestion on real SQL", () => {
  let database: TestDatabase; let clamd: Awaited<ReturnType<typeof startFakeClamd>>;
  let ing: typeof import("./index"); let dbm: typeof import("../db"); let routers: typeof import("../routers");
  let store: InstanceType<typeof ing.UploadStore>; let service: InstanceType<typeof ing.ResumableIngestion>;
  let userA: any, userB: any, wsA: number, wsB: number; let actorA: { workspaceId: number; userId: number };
  const scannerCalls = { n: 0 }; let scanResult: MalwareScanResult = { status: "clean", engine: "stub" }; let scannerNull = false;
  const scanner: MalwareScanner = { engine: "stub", async scan() { scannerCalls.n += 1; return scanResult; } };
  let extractCalls = 0; let extractFail = false;
  const rows = async <T = Record<string, any>>(query: ReturnType<typeof sql>) => ((await database.db.execute(query)) as unknown as [T[]])[0];
  const count = async (table: string) => Number((await rows<{ n: number }>(sql.raw(`SELECT COUNT(*) n FROM ${table}`)))[0].n);
  const flag = { env: { FILE_INGESTION_BACKEND_ENABLED: "true" } as NodeJS.ProcessEnv };
  const build = (over: Partial<ConstructorParameters<typeof ing.ResumableIngestion>[0]> = {}) => new ing.ResumableIngestion({
    store, commit: ing.createCommitter({ embed: async () => null }), scanner: () => (scannerNull ? null : scanner), env: flag.env,
    extract: async (...a) => { extractCalls += 1; if (extractFail) throw new Error("boom"); return ing.defaultExtractor(...a); }, ...over,
  });
  const chunksOf = (buf: Buffer, size = CHUNK) => Array.from({ length: Math.ceil(buf.length / size) }, (_, i) => buf.subarray(i * size, (i + 1) * size));
  const begin = (buf: Buffer, over: Record<string, unknown> = {}, actor = actorA, svc = service) => svc.begin(actor, { filename: "temple.txt", mimeType: "text/plain", sizeBytes: buf.length, sha256: sha(buf), chunkSize: CHUNK, ...over } as any);
  const uploadAll = async (id: string, buf: Buffer, actor = actorA, svc = service) => { for (const [i, c] of chunksOf(buf).entries()) await svc.putChunk(actor, id, i, c); };
  const fail = async (p: Promise<unknown>, code: string) => { const e = await p.then(() => null, x => x); expect(e, `expected ${code}`).toBeInstanceOf(ing.IngestError); expect((e as any).code).toBe(code); };
  let seq = 0; const unique = (text = TXT) => Buffer.from(`${text}\nunique-${++seq}-${Math.random()}`, "utf8");

  beforeAll(async () => {
    database = await createTestDatabase(); clamd = await startFakeClamd();
    Object.assign(process.env, { DATABASE_URL: database.url, DATABASE_EXPECTED_NAME: database.name, JWT_SECRET: "integration-test-secret-not-real-0123456789", VITE_APP_ID: "sakthiai-it" });
    for (const key of ["MALWARE_SCANNER_HOST", "FILE_INGESTION_BACKEND_ENABLED"]) delete process.env[key];
    dbm = await import("../db"); ing = await import("./index"); routers = await import("../routers");
    await dbm.upsertUser({ openId: "ing-a", name: "A", email: "a@example.test", loginMethod: "t" });
    await dbm.upsertUser({ openId: "ing-b", name: "B", email: "b@example.test", loginMethod: "t" });
    userA = await dbm.getUserByOpenId("ing-a"); userB = await dbm.getUserByOpenId("ing-b");
    wsA = (await dbm.ensureWorkspace(userA)).id; wsB = (await dbm.ensureWorkspace(userB)).id; actorA = { workspaceId: wsA, userId: userA.id };
    store = new ing.UploadStore(async () => database.db); service = build();
  });
  afterAll(async () => { clamd?.server.close(); await database?.close(); });
  beforeEach(async () => {
    scannerCalls.n = 0; scanResult = { status: "clean", engine: "stub" }; scannerNull = false; extractCalls = 0; extractFail = false; storageState.puts.length = 0; storageState.failNext = 0;
    await database.db.execute(sql`DELETE FROM fileUploadChunks`); await database.db.execute(sql`DELETE FROM fileUploadSessions`);
    await database.db.execute(sql`DELETE FROM documentChunks`); await database.db.execute(sql`DELETE FROM documents`);
  });

  it("happy path: out-of-order chunks, duplicate retry, resume by a fresh instance, finalize creates one searchable document and purges quarantine", async () => {
    const buf = unique(); const parts = chunksOf(buf);
    const s = await begin(buf); expect(s.totalChunks).toBe(parts.length); expect(parts.length).toBeGreaterThan(3);
    for (const i of [2, 0]) await service.putChunk(actorA, s.uploadId, i, parts[i]);
    expect((await service.putChunk(actorA, s.uploadId, 0, parts[0])).stored).toBe("duplicate"); // retry after a lost response
    const second = build(); // "another server instance" resumes purely from the database
    const st = await second.status(actorA, s.uploadId);
    expect(st.received).toEqual([0, 2]); expect(st.missing).toEqual(parts.map((_, i) => i).filter(i => i !== 0 && i !== 2));
    for (const i of st.missing.reverse()) await second.putChunk(actorA, s.uploadId, i, parts[i], sha(parts[i]));
    expect(await count("documents")).toBe(0); expect(storageState.puts).toHaveLength(0); // still quarantined
    const done = await second.finalize(actorA, s.uploadId);
    expect(done).toMatchObject({ scanner: "clean", bytes: buf.length, contentHash: sha(buf) });
    expect(await count("documents")).toBe(1); expect(storageState.puts).toHaveLength(1); expect(scannerCalls.n).toBe(1);
    const chunkRows = await rows<{ searchText: string | null }>(sql`SELECT searchText FROM documentChunks WHERE documentId = ${done.documentId}`);
    expect(chunkRows.length).toBeGreaterThan(0); expect(chunkRows.every(r => r.searchText && r.searchText.length > 0)).toBe(true);
    expect(await count("fileUploadChunks")).toBe(0);
    expect((await second.status(actorA, s.uploadId)).state).toBe("COMPLETED");
    expect((await second.finalize(actorA, s.uploadId)).documentId).toBe(done.documentId); // idempotent
    expect(storageState.puts).toHaveLength(1); expect(await count("documents")).toBe(1);
  });

  it("is disabled unless FILE_INGESTION_BACKEND_ENABLED=true; nothing is written", async () => {
    const off = build({ env: {} });
    await fail(begin(unique(), {}, actorA, off), "DISABLED");
    expect(await count("fileUploadSessions")).toBe(0);
  });

  it("chunk validation: exact sizes, range, checksum, conflicting content for an already-stored index, closed sessions", async () => {
    const buf = unique(); const parts = chunksOf(buf); const s = await begin(buf);
    await fail(service.putChunk(actorA, s.uploadId, 0, parts[0].subarray(1)), "INVALID");
    await fail(service.putChunk(actorA, s.uploadId, parts.length, parts[0]), "INVALID");
    await fail(service.putChunk(actorA, s.uploadId, -1, parts[0]), "INVALID");
    await fail(service.putChunk(actorA, s.uploadId, 0, parts[0], sha("other")), "INVALID");
    await service.putChunk(actorA, s.uploadId, 0, parts[0]);
    const mutated = Buffer.from(parts[0]); mutated[0] ^= 0xff;
    await fail(service.putChunk(actorA, s.uploadId, 0, mutated), "CONFLICT");
    expect((await store.chunkMeta(s.uploadId))[0].sha256).toBe(sha(parts[0])); // original kept
    await service.abort(actorA, s.uploadId);
    await fail(service.putChunk(actorA, s.uploadId, 1, parts[1]), "CLOSED");
    expect(await count("fileUploadChunks")).toBe(0);
  });

  it("begin validation: size, checksum format, chunk size, extension, active-session limit", async () => {
    const buf = unique();
    await fail(begin(buf, { sizeBytes: 12 * 1024 * 1024 + 1 }), "INVALID");
    await fail(begin(buf, { sizeBytes: 0 }), "INVALID");
    await fail(begin(buf, { sha256: "xyz" }), "INVALID");
    await fail(begin(buf, { chunkSize: 100 }), "INVALID");
    await fail(begin(buf, { chunkSize: 1024 * 1024 }), "INVALID");
    await fail(begin(buf, { filename: "payload.exe" }), "INVALID");
    await fail(begin(buf, { filename: "../../etc/passwd" }), "INVALID"); // no allowed extension after sanitising
    expect((await begin(buf, { filename: "../../évil name.txt" })).uploadId).toBeTruthy();
    for (let i = 0; i < ing.MAX_ACTIVE_SESSIONS_PER_USER - 1; i += 1) await begin(unique());
    await fail(begin(unique()), "LIMIT");
    const stored = await rows<{ filename: string }>(sql`SELECT filename FROM fileUploadSessions`); expect(stored.every(r => /^[A-Za-z0-9._-]+$/.test(r.filename))).toBe(true);
  });

  it("finalize before all chunks arrive is refused and harmless; the upload stays OPEN and resumable", async () => {
    const buf = unique(); const parts = chunksOf(buf); const s = await begin(buf);
    await service.putChunk(actorA, s.uploadId, 0, parts[0]);
    await fail(service.finalize(actorA, s.uploadId), "INCOMPLETE");
    expect(scannerCalls.n).toBe(0); expect((await service.status(actorA, s.uploadId)).state).toBe("OPEN");
    for (let i = 1; i < parts.length; i += 1) await service.putChunk(actorA, s.uploadId, i, parts[i]);
    await service.finalize(actorA, s.uploadId); expect(await count("documents")).toBe(1);
  });

  it("declared checksum/size mismatch: rejected, quarantine purged, scanner/extractor/storage never reached", async () => {
    const buf = unique(); const s = await begin(buf, { sha256: sha("something else") });
    await uploadAll(s.uploadId, buf);
    await fail(service.finalize(actorA, s.uploadId), "INVALID");
    expect((await service.status(actorA, s.uploadId)).rejectReason).toBe("CHECKSUM_MISMATCH");
    expect(scannerCalls.n).toBe(0); expect(extractCalls).toBe(0); expect(storageState.puts).toHaveLength(0);
    expect(await count("fileUploadChunks")).toBe(0); expect(await count("documents")).toBe(0);
  });

  it("file shape: a .pdf without the %PDF magic is rejected before the scanner", async () => {
    const buf = Buffer.from("not really a pdf ".repeat(500)); const s = await begin(buf, { filename: "fake.pdf", mimeType: "application/pdf" });
    await uploadAll(s.uploadId, buf);
    await fail(service.finalize(actorA, s.uploadId), "INVALID");
    expect((await service.status(actorA, s.uploadId)).rejectReason).toBe("INVALID_SHAPE"); expect(scannerCalls.n).toBe(0); expect(await count("fileUploadChunks")).toBe(0);
  });

  it("INFECTED: terminal rejection, quarantine purged, never extracted/stored/retrievable, and stays rejected on retry", async () => {
    scanResult = { status: "infected", engine: "stub", signature: "Eicar-Test-Signature" };
    const buf = unique(); const s = await begin(buf); await uploadAll(s.uploadId, buf);
    await fail(service.finalize(actorA, s.uploadId), "INFECTED");
    expect(extractCalls).toBe(0); expect(storageState.puts).toHaveLength(0);
    expect(await count("documents")).toBe(0); expect(await count("documentChunks")).toBe(0); expect(await count("fileUploadChunks")).toBe(0);
    const st = await service.status(actorA, s.uploadId); expect(st).toMatchObject({ state: "REJECTED", rejectReason: "INFECTED" });
    const [row] = await rows<{ scanStatus: string; scanEngine: string }>(sql`SELECT scanStatus, scanEngine FROM fileUploadSessions WHERE id = ${s.uploadId}`); expect(row.scanStatus).toBe("infected");
    scanResult = { status: "clean", engine: "stub" }; // even if the scanner later says clean, the rejected upload cannot be revived
    await fail(service.finalize(actorA, s.uploadId), "INFECTED"); await fail(service.putChunk(actorA, s.uploadId, 0, chunksOf(buf)[0]), "CLOSED");
    expect(await count("documents")).toBe(0);
  });

  it("scanner unavailable / not configured / erroring: fail closed, bytes stay quarantined, finalize is retryable once the scanner recovers", async () => {
    const buf = unique(); const s = await begin(buf); await uploadAll(s.uploadId, buf);
    scannerNull = true;
    await fail(service.finalize(actorA, s.uploadId), "SCANNER_UNAVAILABLE");
    scannerNull = false; scanResult = { status: "unavailable", engine: "stub", detail: "timeout" };
    await fail(service.finalize(actorA, s.uploadId), "SCANNER_UNAVAILABLE");
    scanResult = { status: "error", engine: "stub", detail: "scan_size_limit_exceeded" };
    await fail(service.finalize(actorA, s.uploadId), "SCANNER_UNAVAILABLE");
    expect(extractCalls).toBe(0); expect(storageState.puts).toHaveLength(0); expect(await count("documents")).toBe(0);
    const mid = await service.status(actorA, s.uploadId); expect(mid.state).toBe("OPEN"); expect(mid.missing).toEqual([]); expect(mid.lastError).toBe("scanner_error");
    expect(await count("fileUploadChunks")).toBe(mid.totalChunks);
    scanResult = { status: "clean", engine: "stub" };
    await service.finalize(actorA, s.uploadId); expect(await count("documents")).toBe(1); expect(await count("fileUploadChunks")).toBe(0);
  });

  it("extraction failure and duplicate content are terminal and leave nothing in normal storage", async () => {
    extractFail = true; const a = unique(); const sa = await begin(a); await uploadAll(sa.uploadId, a);
    await fail(service.finalize(actorA, sa.uploadId), "EXTRACTION_FAILED"); expect(storageState.puts).toHaveLength(0); expect(await count("fileUploadChunks")).toBe(0);
    extractFail = false; const b = unique(); const s1 = await begin(b); await uploadAll(s1.uploadId, b); await service.finalize(actorA, s1.uploadId);
    const s2 = await begin(b); await uploadAll(s2.uploadId, b);
    await fail(service.finalize(actorA, s2.uploadId), "DUPLICATE");
    expect(await count("documents")).toBe(1); expect(storageState.puts).toHaveLength(1); expect(await count("fileUploadChunks")).toBe(0);
    expect((await service.status(actorA, s2.uploadId)).rejectReason).toBe("DUPLICATE");
  });

  it("transient storage failure keeps the upload retryable; a half-written document is rolled back", async () => {
    const buf = unique(); const s = await begin(buf); await uploadAll(s.uploadId, buf);
    storageState.failNext = 1;
    await expect(service.finalize(actorA, s.uploadId)).rejects.toThrow(/object store down/);
    expect((await service.status(actorA, s.uploadId)).state).toBe("OPEN"); expect(await count("documents")).toBe(0);
    let calls = 0; const flaky = build({ commit: ing.createCommitter({ embed: async () => { calls += 1; if (calls === 2) throw new Error("embedder crashed"); return null; } }) });
    await expect(flaky.finalize(actorA, s.uploadId)).rejects.toThrow(/embedder crashed/);
    expect(await count("documents")).toBe(0); expect(await count("documentChunks")).toBe(0); // rolled back
    const done = await service.finalize(actorA, s.uploadId); expect(done.documentId).toBeGreaterThan(0); expect(await count("documents")).toBe(1);
  });

  it("concurrent finalizers: exactly one document and one storage write", async () => {
    const buf = unique(); const s = await begin(buf); await uploadAll(s.uploadId, buf);
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => build().finalize(actorA, s.uploadId)));
    expect(await count("documents")).toBe(1); expect(storageState.puts).toHaveLength(1);
    const ok = results.filter(r => r.status === "fulfilled") as PromiseFulfilledResult<{ documentId: number }>[];
    expect(ok.length).toBeGreaterThanOrEqual(1); expect(new Set(ok.map(r => r.value.documentId)).size).toBe(1);
    for (const r of results) if (r.status === "rejected") expect((r.reason as any).code).toBe("CONFLICT");
  });

  it("finalize lock is a state machine: only OPEN sessions can enter FINALIZING, exactly once; terminal sessions never revive", async () => {
    const buf = unique(); const s = await begin(buf); const session = (await store.get(actorA.workspaceId, actorA.userId, s.uploadId))!;
    expect(await store.beginFinalize(session)).toBe(true); expect(await store.beginFinalize(session)).toBe(false);
    await fail(service.finalize(actorA, s.uploadId), "CONFLICT"); // another finalizer is working
    await store.reject(s.uploadId, "TEST"); expect(await store.beginFinalize(session)).toBe(false);
    const done = unique(); const sd = await begin(done); await uploadAll(sd.uploadId, done); await service.finalize(actorA, sd.uploadId);
    expect(await store.beginFinalize((await store.get(actorA.workspaceId, actorA.userId, sd.uploadId))!)).toBe(false);
    expect((await service.status(actorA, sd.uploadId)).state).toBe("COMPLETED");
  });

  it("tenant isolation: another workspace or another user in the same workspace sees NOT_FOUND for every operation", async () => {
    const buf = unique(); const s = await begin(buf); const parts = chunksOf(buf); await service.putChunk(actorA, s.uploadId, 0, parts[0]);
    await dbm.getDb().then(db => db!.execute(sql`INSERT INTO workspaceMembers (workspaceId, userId, role) VALUES (${wsA}, ${userB.id}, 'member')`)).catch(() => undefined);
    for (const other of [{ workspaceId: wsB, userId: userB.id }, { workspaceId: wsA, userId: userB.id }, { workspaceId: wsB, userId: userA.id }]) {
      await fail(service.status(other, s.uploadId), "NOT_FOUND"); await fail(service.putChunk(other, s.uploadId, 1, parts[1]), "NOT_FOUND");
      await fail(service.finalize(other, s.uploadId), "NOT_FOUND"); await fail(service.abort(other, s.uploadId), "NOT_FOUND");
    }
    await fail(service.status(actorA, "not-a-uuid"), "NOT_FOUND");
    expect((await service.status(actorA, s.uploadId)).received).toEqual([0]); expect((await service.status(actorA, s.uploadId)).state).toBe("OPEN");
    expect(await count("fileUploadChunks")).toBe(1);
  });

  it("expiry and cleanup: expired sessions refuse chunks and finalize; cleanup purges them, recovers dead finalizers and never touches live uploads", async () => {
    const live = unique(); const sl = await begin(live); await service.putChunk(actorA, sl.uploadId, 0, chunksOf(live)[0]);
    const old = unique(); const so = await begin(old); await service.putChunk(actorA, so.uploadId, 0, chunksOf(old)[0]);
    await database.db.execute(sql`UPDATE fileUploadSessions SET expiresAt = DATE_SUB(NOW(3), INTERVAL 1 MINUTE) WHERE id = ${so.uploadId}`);
    await fail(service.putChunk(actorA, so.uploadId, 1, chunksOf(old)[1]), "CLOSED");
    await fail(service.finalize(actorA, so.uploadId), "INCOMPLETE");
    const dead = unique(); const sd = await begin(dead); await uploadAll(sd.uploadId, dead);
    await database.db.execute(sql`UPDATE fileUploadSessions SET state='FINALIZING', updatedAt = DATE_SUB(NOW(3), INTERVAL 10 MINUTE) WHERE id = ${sd.uploadId}`);
    const orphan = "00000000-0000-4000-8000-000000000000";
    await database.db.execute(sql`INSERT INTO fileUploadChunks (uploadId, chunkIndex, bytes, sha256, data) VALUES (${orphan}, 0, 1, ${sha("x")}, ${Buffer.from("x")})`);
    const report = await store.cleanup();
    expect(report.expired).toBe(1); expect(report.recovered).toBe(1); expect(report.purgedChunkRows).toBeGreaterThanOrEqual(2);
    expect((await service.status(actorA, so.uploadId)).state).toBe("EXPIRED");
    expect((await service.status(actorA, sd.uploadId)).state).toBe("OPEN");
    expect((await service.status(actorA, sl.uploadId))).toMatchObject({ state: "OPEN", received: [0] }); // live upload untouched
    expect((await rows<{ n: number }>(sql`SELECT COUNT(*) n FROM fileUploadChunks WHERE uploadId = ${so.uploadId} OR uploadId = ${orphan}`))[0].n).toBe(0);
    await database.db.execute(sql`UPDATE fileUploadSessions SET updatedAt = DATE_SUB(NOW(3), INTERVAL 30 DAY) WHERE id = ${so.uploadId}`);
    expect((await store.cleanup()).deletedSessions).toBe(1);
    await service.finalize(actorA, sd.uploadId); expect(await count("documents")).toBe(1); // recovered upload completes
  });

  describe("through tRPC with a real clamd INSTREAM exchange", () => {
    const callerFor = (user: any) => routers.appRouter.createCaller({ user, req: { protocol: "https", headers: {} } as Request, res: { headersSent: false, setHeader: () => undefined, clearCookie: () => undefined } as any, requestId: "it" } as any);
    const b64 = (b: Buffer) => b.toString("base64");
    const run = async (caller: any, workspaceId: number, buf: Buffer) => {
      const s = await caller.files.resumable.begin({ workspaceId, filename: "doc.txt", mimeType: "text/plain", sizeBytes: buf.length, sha256: sha(buf), chunkSize: CHUNK });
      for (const [i, c] of chunksOf(buf).entries()) await caller.files.resumable.putChunk({ workspaceId, uploadId: s.uploadId, index: i, dataBase64: b64(c) });
      return s.uploadId as string;
    };
    it("is FORBIDDEN while the backend flag is off; with it on, clean files ingest, EICAR is rejected, scanner outage fails closed, foreign users are denied", async () => {
      await dbm.upsertUser({ openId: "ing-c", name: "C", email: "c@example.test", loginMethod: "t" });
      const a = callerFor(userA); const b = callerFor(await dbm.getUserByOpenId("ing-c")); // C has no workspace membership in wsA
      delete process.env.FILE_INGESTION_BACKEND_ENABLED;
      await expect(a.files.resumable.begin({ workspaceId: wsA, filename: "x.txt", mimeType: "text/plain", sizeBytes: 10, sha256: sha("x"), chunkSize: CHUNK })).rejects.toMatchObject({ code: "FORBIDDEN" });
      Object.assign(process.env, { FILE_INGESTION_BACKEND_ENABLED: "true" });
      try {
        // scanner not configured -> 503 and nothing normal
        delete process.env.MALWARE_SCANNER_HOST;
        const pending = await run(a, wsA, unique());
        await expect(a.files.resumable.finalize({ workspaceId: wsA, uploadId: pending })).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
        expect(await count("documents")).toBe(0);
        Object.assign(process.env, { MALWARE_SCANNER_HOST: "127.0.0.1", MALWARE_SCANNER_PORT: String(clamd.port) });
        const done = await a.files.resumable.finalize({ workspaceId: wsA, uploadId: pending }); // same quarantined upload, now scanned clean
        expect(done.scanner).toBe("clean"); expect(await count("documents")).toBe(1);
        expect((await a.files.list({ workspaceId: wsA })).map((d: any) => d.id)).toContain(done.documentId);
        const eicar = await run(a, wsA, Buffer.from(`X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*\n${"pad ".repeat(2000)}`));
        await expect(a.files.resumable.finalize({ workspaceId: wsA, uploadId: eicar })).rejects.toMatchObject({ code: "BAD_REQUEST", message: /quarantined/ });
        expect(await count("documents")).toBe(1); expect(await count("fileUploadChunks")).toBe(0);
        // foreign workspace -> FORBIDDEN; own workspace with a foreign upload id -> NOT_FOUND
        await expect(b.files.resumable.status({ workspaceId: wsA, uploadId: pending })).rejects.toMatchObject({ code: "FORBIDDEN" });
        const bu = callerFor(userB);
        await expect(bu.files.resumable.status({ workspaceId: wsB, uploadId: pending })).rejects.toMatchObject({ code: "NOT_FOUND" });
        await expect(bu.files.resumable.finalize({ workspaceId: wsB, uploadId: pending })).rejects.toMatchObject({ code: "NOT_FOUND" });
      } finally { delete process.env.FILE_INGESTION_BACKEND_ENABLED; delete process.env.MALWARE_SCANNER_HOST; delete process.env.MALWARE_SCANNER_PORT; }
    });
  });
});
