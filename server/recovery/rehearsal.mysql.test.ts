import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2";
import mysqlP from "mysql2/promise";
import { mysqlTestUrl, skipMysqlSuite } from "../testing/mysqlTestDb";
import { MysqlBudgetStore } from "../gateway";
import { MysqlTaskStore, TaskRetryableError, TaskWorker } from "../tasks";
import { MysqlLoginTransactionStore } from "../_core/loginTransactions";
import { backfillSearchText, searchTextFor, searchWorkspaceChunks } from "../retrievalStore";
import { normalizeRetrievalText } from "../retrieval";
import {
  RehearsalRefused, RestoreFailed, applyMigrations, backupDatabase, checkBackupIntegrity, createScratchDatabase, dropScratchDatabase, parseTarget, readBackup, readJournal,
  restoreDatabase, verifyAgainstBackup, withDatabase, writeBackup, type Backup,
} from "./rehearsal";

/**
 * LOCAL BACKUP / RESTORE / ROLLBACK REHEARSAL on a throwaway MySQL-compatible server (never a managed host).
 * Migrations are forward-only: there is NO schema downgrade here. "Rollback" = restore a pre-migration backup into a fresh
 * database and verify it; data written after that backup is lost (RPO = backup age). Scale is rehearsal-sized, so timings are
 * evidence that the PROCEDURE works, not a statement about production RTO/RPO.
 */
const TAGS = readJournal().entries.map(e => e.tag);
const REPORT = process.env.RECOVERY_REPORT_PATH ?? "reports/recovery/recovery-report.json";
const scenarios: Array<{ name: string; ok: boolean; ms: number; evidence: Record<string, unknown> }> = [];
const TAMIL = "முருகன் கோவில் பழநியில் உள்ளது. The Murugan temple opens at 6am.";

describe.skipIf(skipMysqlSuite())("backup / restore / rollback rehearsal on a throwaway local database", () => {
  const base = mysqlTestUrl(); const scratch: string[] = []; const dir = mkdtempSync(path.join(tmpdir(), "sakthi-recovery-"));
  let engine = "unknown";
  const openDb = (url: string) => { const pool = mysql.createPool({ uri: url, connectionLimit: 8 }); return { db: drizzle(pool), end: () => pool.promise().end() }; };
  const fresh = async (migrate: "all" | string | null = "all") => { const s = await createScratchDatabase(base); scratch.push(s.name); if (migrate === "all") await applyMigrations(s.url); else if (migrate) await applyMigrations(s.url, { upTo: migrate }); return s; };
  const rows = async <T = Record<string, any>>(db: ReturnType<typeof drizzle>, q: ReturnType<typeof sql>) => ((await db.execute(q)) as unknown as [T[]])[0];
  const record = async (name: string, run: () => Promise<Record<string, unknown>>) => { const t0 = Date.now(); try { const evidence = await run(); scenarios.push({ name, ok: true, ms: Date.now() - t0, evidence }); } catch (e) { scenarios.push({ name, ok: false, ms: Date.now() - t0, evidence: { error: (e as Error).message } }); throw e; } };
  const today = () => new Date().toISOString().slice(0, 10);

  /** Representative data across every durable subsystem, written through real code paths where they exist. */
  async function seed(url: string) {
    const { db, end } = openDb(url); const getDb = async () => db;
    try {
      await db.execute(sql`INSERT INTO users (openId, name, email, loginMethod) VALUES ('rr-a','அ','a@example.test','t'),('rr-b','B','b@example.test','t')`);
      await db.execute(sql`INSERT INTO workspaces (ownerUserId, name, slug) VALUES (1,'WS A','ws-a'),(2,'WS B','ws-b')`);
      await db.execute(sql`INSERT INTO workspaceMembers (workspaceId, userId, role) VALUES (1,1,'owner'),(2,2,'owner')`);
      await db.execute(sql`INSERT INTO projects (workspaceId, name) VALUES (1,'P1')`);
      await db.execute(sql`INSERT INTO documents (workspaceId, projectId, filename, mimeType, storageKey, extractedText, contentHash, pageCount) VALUES (1,1,'temple.txt','text/plain','1/1/temple.txt-abcd',${TAMIL},${"a".repeat(64)},1)`);
      await db.execute(sql`INSERT INTO documentChunks (documentId, workspaceId, chunkIndex, content, searchText) VALUES (1,1,0,${TAMIL},${normalizeRetrievalText(TAMIL)}),(1,1,1,${"legacy chunk பழநி"},NULL)`);
      await db.execute(sql`INSERT INTO providerWorkspacePolicies (workspaceId, externalEnabled, meteredEnabled, maxRequestsPerDay, maxTokensPerDay, maxCostPerDay) VALUES (1,1,1,3,1000,2.5),(2,1,0,10,NULL,NULL)`);
      await db.execute(sql`INSERT INTO providerUsageWindows (workspaceId, windowStart, requests, tokens, cost, estimatedCommits) VALUES (1,${today()},3,900,2.25,1),(2,${today()},1,10,0,0)`);
      await db.execute(sql`INSERT INTO providerUsageHolds (id, workspaceId, providerId, windowStart, tokens, cost, state) VALUES ('hold-1',1,'ext-1',${today()},100,0.25,'HELD'),('hold-2',1,'ext-1',${today()},50,0.1,'COMMITTED')`);
      const login = new MysqlLoginTransactionStore(getDb);
      await login.begin("n".repeat(43), "c".repeat(43)); await login.begin("m".repeat(43), "d".repeat(43));
      await db.execute(sql`INSERT INTO oauthLoginTransactions (nonceHash, challengeHash, createdAt, expiresAt, consumedAt) VALUES (${"e".repeat(64)}, ${"f".repeat(64)}, DATE_SUB(NOW(3), INTERVAL 2 HOUR), DATE_SUB(NOW(3), INTERVAL 1 HOUR), NULL)`);
      await db.execute(sql`INSERT INTO mcpConnectors (id, workspaceId, name, endpoint, enabled, createdAt, updatedAt) VALUES (${"a".repeat(8) + "-0000-4000-8000-000000000001"},1,'docs','https://mcp.example.test/mcp',1,NOW(3),NOW(3))`);
      await db.execute(sql`INSERT INTO fileUploadSessions (id, workspaceId, userId, filename, mimeType, declaredBytes, declaredSha256, chunkSize, totalChunks, state, createdAt, updatedAt, expiresAt) VALUES (${"b".repeat(8) + "-0000-4000-8000-000000000002"},1,1,'big.txt','text/plain',8192,${"1".repeat(64)},4096,2,'OPEN',NOW(3),NOW(3),DATE_ADD(NOW(3), INTERVAL 1 HOUR))`);
      await db.execute(sql`INSERT INTO fileUploadChunks (uploadId, chunkIndex, bytes, sha256, data) VALUES (${"b".repeat(8) + "-0000-4000-8000-000000000002"},0,4,${"2".repeat(64)},${Buffer.from([0, 255, 1, 128])})`);
      // A task that checkpointed, recorded a side effect and then failed retryably: it must resume after a restore.
      const store = new MysqlTaskStore(getDb); let effectRuns = 0;
      await store.create({ workspaceId: 1, type: "rehearsal.resume", input: { n: 1 }, idempotencyKey: "rr-1", maxAttempts: 5 });
      await new TaskWorker({ store, backoffBaseMs: 10, backoffMaxMs: 20, handlers: { "rehearsal.resume": async ctx => { await ctx.effect("send-email", async () => { effectRuns += 1; return "sent-1"; }); await ctx.saveCheckpoint({ step: 1, note: "பழநி" }); throw new TaskRetryableError("transient"); } } }).runOnce();
      expect(effectRuns).toBe(1);
      await store.create({ workspaceId: 2, type: "rehearsal.other", input: {} });
    } finally { await end(); }
  }

  beforeAll(async () => { const c = await mysqlP.createConnection(base).catch(() => null); if (c) { engine = ((await c.query("SELECT VERSION() v")) as any)[0][0].v; await c.end(); } });
  afterAll(async () => {
    for (const n of scratch) await dropScratchDatabase(base, n).catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(path.dirname(REPORT), { recursive: true });
    writeFileSync(REPORT, `${JSON.stringify({
      schema: "sakthiai.recovery-rehearsal/v1", evidenceClass: "LOCAL_REHEARSAL", engine, managedDatabaseTouched: false, aivenTouched: false, productionDatabaseTouched: false,
      schemaDowngrade: "NOT_SUPPORTED_FORWARD_ONLY", rollbackMethod: "restore pre-migration backup into a fresh database and verify; post-backup writes are lost (RPO = backup age)",
      scaleNote: "rehearsal-sized data; timings prove the procedure, not production RTO/RPO", migrations: TAGS, generatedAt: new Date().toISOString(),
      scenarios, passed: scenarios.length > 0 && scenarios.every(s => s.ok),
    }, null, 2)}\n`);
  });

  it("full cycle at the latest schema: backup -> file -> restore into an EMPTY database -> every table's row count and checksum verified", async () => {
    await record("full-cycle-latest", async () => {
      const src = await fresh(); await seed(src.url);
      const backup = await backupDatabase(src.url, { migrationTags: TAGS });
      expect(checkBackupIntegrity(backup)).toEqual([]);
      const file = path.join(dir, "full.json"); writeBackup(file, backup);
      const loaded = readBackup(file); expect(checkBackupIntegrity(loaded)).toEqual([]);
      const dst = await fresh(null);
      const result = await restoreDatabase(dst.url, loaded);
      expect(result.mismatches).toEqual([]); expect(result.ok).toBe(true);
      const counts = Object.fromEntries(result.tables.map(t => [t.table, t.actualRows]));
      expect(result.tables.length).toBe(backup.tables.length); expect(result.tables.length).toBeGreaterThanOrEqual(30); // every migrated table is in the backup
      expect(counts.users).toBe(2); expect(counts.documentChunks).toBe(2); expect(counts.durableTasks).toBe(2); expect(counts.fileUploadChunks).toBe(1); expect(counts.providerUsageHolds).toBe(2);
      // binary and Unicode survive byte-for-byte
      const { db, end } = openDb(dst.url);
      try {
        const [chunk] = await rows<{ data: Buffer }>(db, sql`SELECT data FROM fileUploadChunks`); expect([...Buffer.from(chunk.data)]).toEqual([0, 255, 1, 128]);
        const [doc] = await rows<{ extractedText: string }>(db, sql`SELECT extractedText FROM documents`); expect(doc.extractedText).toBe(TAMIL);
        // AUTO_INCREMENT counters continue (no id reuse after restore)
        await db.execute(sql`INSERT INTO users (openId, name) VALUES ('rr-new','N')`); const [u] = await rows<{ id: number }>(db, sql`SELECT id FROM users WHERE openId='rr-new'`); expect(Number(u.id)).toBe(3);
      } finally { await end(); }
      return { tables: result.tables.length, rowsTotal: result.tables.reduce((s, t) => s + t.actualRows, 0), backupDigest: backup.manifest.digest, migrations: TAGS.length };
    });
  });

  it("refuses unsafe restores: non-empty target, the source database, tampered or truncated backups, newer/unknown schema, managed hosts", async () => {
    await record("restore-refusals", async () => {
      const src = await fresh(); await seed(src.url); const backup = await backupDatabase(src.url, { migrationTags: TAGS });
      const refused = async (p: Promise<unknown>, re: RegExp) => { const e = await p.then(() => null, x => x); expect(e).toBeInstanceOf(RehearsalRefused); expect((e as Error).message).toMatch(re); };
      await refused(restoreDatabase(src.url, backup), /source database/);
      const populated = await fresh(); await refused(restoreDatabase(populated.url, backup), /not empty/);
      const tampered: Backup = JSON.parse(JSON.stringify(backup)); const docs = tampered.tables.find(t => t.name === "documents")!; docs.rows[0][docs.columns.indexOf("filename")] = "evil.txt";
      const empty1 = await fresh(null); await refused(restoreDatabase(empty1.url, tampered), /integrity/);
      expect((await mysqlP.createConnection(empty1.url).then(async c => { const [r] = await c.query("SHOW TABLES"); await c.end(); return r as any[]; })).length).toBe(0); // nothing was written
      const truncated: Backup = JSON.parse(JSON.stringify(backup)); truncated.tables.find(t => t.name === "users")!.rows.pop();
      await refused(restoreDatabase((await fresh(null)).url, truncated), /integrity/);
      const newer = await backupDatabase(src.url, { migrationTags: [...TAGS, "9999_future"] }); // internally consistent, but from a schema this build does not know
      expect(checkBackupIntegrity(newer)).toEqual([]);
      await refused(restoreDatabase((await fresh(null)).url, newer), /prefix/);
      await refused(restoreDatabase((await fresh(null)).url, await backupDatabase(src.url, { migrationTags: [TAGS[1], TAGS[0]] })), /prefix/);
      for (const host of ["x.aivencloud.com", "svc.render.com", "db.abc.rds.amazonaws.com", "srv.database.azure.com"]) expect(() => parseTarget(`mysql://u:p@${host}:3306/db`)).toThrow(RehearsalRefused);
      expect(() => parseTarget("mysql://u:p@10.1.2.3:3306/db")).toThrow(RehearsalRefused);
      await expect(dropScratchDatabase(base, "production")).rejects.toBeInstanceOf(RehearsalRefused);
      return { refusals: 9 };
    });
  });

  it("an interrupted restore is reported as failed and the half-built target is detected by verification, never accepted", async () => {
    await record("interrupted-restore", async () => {
      const src = await fresh(); await seed(src.url); const backup = await backupDatabase(src.url, { migrationTags: TAGS });
      const dst = await fresh(null);
      await expect(restoreDatabase(dst.url, backup, { failAfterRows: 3 })).rejects.toBeInstanceOf(RestoreFailed);
      const check = await verifyAgainstBackup(dst.url, backup);
      expect(check.ok).toBe(false); expect(check.mismatches.length).toBeGreaterThan(5);
      // procedure: discard the failed target and retry into a new empty database
      const retry = await fresh(null); expect((await restoreDatabase(retry.url, backup)).ok).toBe(true);
      return { mismatchesOnPartial: check.mismatches.length };
    });
  });

  it("upgrade path: restore an OLD-schema backup, migrate to latest, data intact, searchText backfill is complete and idempotent", async () => {
    await record("upgrade-old-backup-to-latest", async () => {
      const OLD = "0005_provider_policy_runtime";
      const old = await fresh(OLD); const oldTags = TAGS.slice(0, TAGS.indexOf(OLD) + 1);
      const { db: oldDb, end } = openDb(old.url);
      try {
        await oldDb.execute(sql`INSERT INTO users (openId, name) VALUES ('legacy','L')`); await oldDb.execute(sql`INSERT INTO workspaces (ownerUserId, name, slug) VALUES (1,'Legacy','legacy')`);
        await oldDb.execute(sql`INSERT INTO documents (workspaceId, filename, mimeType, extractedText, contentHash, pageCount) VALUES (1,'old.txt','text/plain',${TAMIL},${"9".repeat(64)},1)`);
        await oldDb.execute(sql`INSERT INTO documentChunks (documentId, workspaceId, chunkIndex, content) VALUES (1,1,0,${TAMIL}),(1,1,1,'second legacy chunk about பழநி')`);
        await oldDb.execute(sql`INSERT INTO providerWorkspacePolicies (workspaceId, externalEnabled, meteredEnabled, maxRequestsPerDay) VALUES (1,1,0,7)`);
        await oldDb.execute(sql`INSERT INTO providerUsageWindows (workspaceId, windowStart, requests, tokens, cost) VALUES (1,${today()},2,40,0)`);
      } finally { await end(); }
      const backup = await backupDatabase(old.url, { migrationTags: oldTags });
      expect(backup.tables.find(t => t.name === "documentChunks")!.columns).not.toContain("searchText");
      const restored = await fresh(null); expect((await restoreDatabase(restored.url, backup)).ok).toBe(true);
      const applied = await applyMigrations(restored.url, { after: OLD }); expect(applied).toEqual(TAGS.slice(TAGS.indexOf(OLD) + 1));
      // every pre-existing table still hashes identically over its ORIGINAL columns; additive migrations are not data loss
      const verify = await verifyAgainstBackup(restored.url, backup); expect(verify.mismatches).toEqual([]);
      const { db, end: end2 } = openDb(restored.url);
      try {
        const [{ n: legacyNull }] = await rows<{ n: number }>(db, sql`SELECT COUNT(*) n FROM documentChunks WHERE searchText IS NULL`); expect(Number(legacyNull)).toBe(2);
        for (const table of ["durableTasks", "oauthLoginTransactions", "mcpConnectors", "fileUploadSessions"]) expect(Number((await rows<{ n: number }>(db, sql.raw(`SELECT COUNT(*) n FROM ${table}`)))[0].n)).toBe(0);
        // legacy rows are still searchable before the backfill (bounded legacy scan) ...
        expect((await searchWorkspaceChunks(db as any, 1, "பழநி", null)).length).toBeGreaterThan(0);
        expect(await backfillSearchText(db as any)).toBe(2); expect(await backfillSearchText(db as any)).toBe(0); // ... and the backfill is complete + idempotent
        for (const r of await rows<{ content: string; searchText: string }>(db, sql`SELECT content, searchText FROM documentChunks`)) { expect(r.searchText).toBe(searchTextFor(r.content)); expect(r.searchText.startsWith(normalizeRetrievalText(r.content))).toBe(true); expect(r.searchText).toContain("~tl~"); }
        expect((await searchWorkspaceChunks(db as any, 1, "பழநி", null)).length).toBeGreaterThan(0);
        // schema equals a freshly migrated database (no drift from the upgrade path)
        const ref = await fresh(); const cols = async (name: string) => (await rows<{ t: string; c: string; ty: string }>(db, sql`SELECT TABLE_NAME t, COLUMN_NAME c, COLUMN_TYPE ty FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ${name} ORDER BY TABLE_NAME, ORDINAL_POSITION`)).map(r => `${r.t}.${r.c}:${r.ty}`);
        expect(await cols(withDatabase(base, restored.url.split("/").pop()!).split("/").pop()!)).toEqual(await cols(ref.name));
      } finally { await end2(); }
      return { oldSchema: OLD, migrationsApplied: applied.length, backfilled: 2 };
    });
  });

  it("provider policy and budget counters survive a restore and still enforce the same limits", async () => {
    await record("provider-policy-budget-preserved", async () => {
      const src = await fresh(); await seed(src.url); const backup = await backupDatabase(src.url, { migrationTags: TAGS });
      const dst = await fresh(null); await restoreDatabase(dst.url, backup);
      const { db, end } = openDb(dst.url);
      try {
        const budget = new MysqlBudgetStore(async () => db as any);
        const policy1 = { externalEnabled: true, maxRequests: 3, maxTokens: 1000, maxCost: 2.5 } as any;
        expect(await budget.usage(1)).toEqual({ requests: 3, tokens: 900, cost: 2.25, estimatedCommits: 1 });
        const denied = await budget.reserve({ workspaceId: 1, providerId: "ext-1", requestId: "r1", estimatedTokens: 10, estimatedCost: 0.01, policy: policy1 });
        expect(denied).toMatchObject({ ok: false, reason: "requests_exhausted" }); // 3 of 3 used before the backup
        expect(await budget.usage(1)).toEqual({ requests: 3, tokens: 900, cost: 2.25, estimatedCommits: 1 }); // a denial changes nothing
        const ok = await budget.reserve({ workspaceId: 2, providerId: "ext-1", requestId: "r2", estimatedTokens: 5, policy: { externalEnabled: true, maxRequests: 10 } as any });
        expect(ok.ok).toBe(true);
        const policy = await rows<{ workspaceId: number; externalEnabled: number; meteredEnabled: number; maxRequestsPerDay: string; maxCostPerDay: string | null }>(db, sql`SELECT workspaceId, externalEnabled, meteredEnabled, maxRequestsPerDay, maxCostPerDay FROM providerWorkspacePolicies ORDER BY workspaceId`);
        expect(policy.map(p => [Number(p.workspaceId), Number(p.externalEnabled), Number(p.meteredEnabled), Number(p.maxRequestsPerDay)])).toEqual([[1, 1, 1, 3], [2, 1, 0, 10]]);
        expect((await rows<{ state: string }>(db, sql`SELECT state FROM providerUsageHolds WHERE id IN ('hold-1','hold-2') ORDER BY id`)).map(h => h.state)).toEqual(["HELD", "COMMITTED"]); // restored holds keep their state
      } finally { await end(); }
      return { workspacesChecked: 2, holdStates: ["HELD", "COMMITTED"] };
    });
  });

  it("tasks, checkpoints and recorded effects survive a restore: the retrying task resumes from its checkpoint and does NOT repeat the effect", async () => {
    await record("task-checkpoint-effect-preserved", async () => {
      const src = await fresh(); await seed(src.url); const backup = await backupDatabase(src.url, { migrationTags: TAGS });
      const dst = await fresh(null); expect((await restoreDatabase(dst.url, backup)).ok).toBe(true);
      const { db, end } = openDb(dst.url);
      try {
        const store = new MysqlTaskStore(async () => db as any);
        const [before] = await rows<{ state: string; attempt: number; checkpointJson: string; checkpointSeq: number }>(db, sql`SELECT state, attempt, checkpointJson, checkpointSeq FROM durableTasks WHERE workspaceId = 1`);
        expect(before).toMatchObject({ state: "WAITING" }); expect(Number(before.attempt)).toBe(1); expect(JSON.parse(before.checkpointJson)).toEqual({ step: 1, note: "பழநி" });
        await db.execute(sql`UPDATE durableTasks SET retryAfter = DATE_SUB(NOW(3), INTERVAL 1 SECOND) WHERE workspaceId = 1`);
        let effectRuns = 0; let seen: unknown = null; let effectResult: unknown = null;
        const result = await new TaskWorker({ store, handlers: { "rehearsal.resume": async ctx => { seen = ctx.checkpoint; effectResult = await ctx.effect("send-email", async () => { effectRuns += 1; return "sent-AGAIN"; }); return "done"; } } }).runOnce();
        expect(result.status).toBe("succeeded"); expect(seen).toEqual({ step: 1, note: "பழநி" }); expect(effectRuns).toBe(0); expect(effectResult).toBe("sent-1");
        const [after] = await rows<{ state: string; attempt: number }>(db, sql`SELECT state, attempt FROM durableTasks WHERE workspaceId = 1`); expect(after.state).toBe("SUCCEEDED"); expect(Number(after.attempt)).toBe(2);
        expect((await store.get(2, (await rows<{ id: string }>(db, sql`SELECT id FROM durableTasks WHERE workspaceId = 2`))[0].id))!.state).toBe("QUEUED"); // other tenant's task untouched
      } finally { await end(); }
      return { resumedFromCheckpoint: true, effectRepeated: false };
    });
  });

  it("OAuth login transactions after restore: live ones consume exactly once, expired ones are rejected, cleanup removes only expired rows", async () => {
    await record("oauth-transactions-after-restore", async () => {
      const src = await fresh(); await seed(src.url); const backup = await backupDatabase(src.url, { migrationTags: TAGS });
      const dst = await fresh(null); await restoreDatabase(dst.url, backup);
      const { db, end } = openDb(dst.url);
      try {
        const store = new MysqlLoginTransactionStore(async () => db as any);
        expect(await store.consume("n".repeat(43), "c".repeat(43))).toBe(true); expect(await store.consume("n".repeat(43), "c".repeat(43))).toBe(false); // replay refused
        expect(await store.consume("m".repeat(43), "WRONG".padEnd(43, "x"))).toBe(false); // wrong challenge does not burn it
        expect(await store.consume("m".repeat(43), "d".repeat(43))).toBe(true);
        expect(await store.consume("z".repeat(43), "c".repeat(43))).toBe(false); // unknown
        await store.begin("live".padEnd(43, "l"), "k".repeat(43));
        const removed = await store.cleanup(); expect(removed).toBeGreaterThanOrEqual(1); // the 1h-expired seed row
        expect(await store.consume("live".padEnd(43, "l"), "k".repeat(43))).toBe(true); // a live row was never touched by cleanup
        const left = await rows<{ n: number }>(db, sql`SELECT COUNT(*) n FROM oauthLoginTransactions WHERE expiresAt < DATE_SUB(NOW(3), INTERVAL 60 SECOND)`); expect(Number(left[0].n)).toBe(0);
      } finally { await end(); }
      return { replayRefused: true, cleanupRemoved: true };
    });
  });

  it("rollback rehearsal: a bad migration is DETECTED against the pre-migration backup, recovery restores a verified copy, post-backup writes are lost (documented RPO)", async () => {
    await record("bad-migration-rollback", async () => {
      const live = await fresh(); await seed(live.url);
      const pre = await backupDatabase(live.url, { migrationTags: TAGS }); const file = path.join(dir, "pre-migration.json"); writeBackup(file, pre);
      const { db, end } = openDb(live.url);
      try {
        // 1) "migration 0011" goes wrong: it drops a column and clobbers data
        await db.execute(sql`ALTER TABLE documents DROP COLUMN contentHash`); await db.execute(sql`UPDATE providerWorkspacePolicies SET maxRequestsPerDay = NULL`);
        // 2) a user writes AFTER the backup was taken
        await db.execute(sql`INSERT INTO users (openId, name) VALUES ('after-backup','Late')`);
        // 3) detection: verification against the pre-migration manifest names exactly the damaged tables
        const damage = await verifyAgainstBackup(live.url, pre);
        expect(damage.ok).toBe(false); expect(damage.mismatches.map(m => m.split(":")[0]).sort()).toEqual(["documents", "providerWorkspacePolicies", "users"]);
      } finally { await end(); }
      // 4) recovery: restore the backup FILE into a fresh database, verify, and switch to it
      const t0 = Date.now(); const recovered = await fresh(null); const restored = await restoreDatabase(recovered.url, readBackup(file)); const ms = Date.now() - t0;
      expect(restored.ok).toBe(true);
      const { db: rdb, end: rend } = openDb(recovered.url);
      try {
        expect((await rows(rdb, sql`SELECT openId FROM users WHERE openId = 'after-backup'`)).length).toBe(0); // RPO: post-backup write is gone
        expect(Number((await rows<{ n: number }>(rdb, sql`SELECT COUNT(*) n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'documents' AND COLUMN_NAME = 'contentHash'`))[0].n)).toBe(1); // dropped column is back
        expect(Number((await rows<{ m: string }>(rdb, sql`SELECT maxRequestsPerDay m FROM providerWorkspacePolicies WHERE workspaceId = 1`))[0].m)).toBe(3);
      } finally { await rend(); }
      return { detectedTables: 3, recoveryMs: ms, lostPostBackupWrites: 1 };
    });
  });

  it("migrations are forward-only: no down/rollback SQL or journal entries exist, and the rehearsal never claims a schema downgrade", () => {
    const files = readdirSync("drizzle"); expect(files.filter(f => /(^|[._-])(down|rollback|revert)([._-]|$)/i.test(f))).toEqual([]);
    const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")); for (const e of journal.entries) expect(Object.keys(e).sort()).toEqual(["breakpoints", "idx", "tag", "version", "when"]);
    scenarios.push({ name: "forward-only-migrations", ok: true, ms: 0, evidence: { migrations: journal.entries.length, downFiles: 0 } });
  });
});
