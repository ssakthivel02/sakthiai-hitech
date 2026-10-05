// Real MySQL 8: the preview-db-setup guard sequence (pre -> migrate -> post -> migrate again -> rerun) against throwaway
// databases built with the real Drizzle migrator, so __drizzle_migrations has exactly the format drizzle-kit writes.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import mysql from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import { afterAll, describe, expect, it } from "vitest";
import { createScratchDatabase, dropScratchDatabase } from "../server/recovery/rehearsal";
import { mysqlTestUrl, skipMysqlSuite } from "../server/testing/mysqlTestDb";
import { runGuard } from "../scripts/preview-migration-guard.mjs";

const root = path.resolve(import.meta.dirname, "..");
const BASELINE = "0004_creator_spend_control";

describe.skipIf(skipMysqlSuite())("preview migration guard on real MySQL", { timeout: 60_000 }, () => {
  const base = mysqlTestUrl();
  const cleanup = [];
  afterAll(async () => { for (const fn of cleanup.reverse()) await fn(); });

  const journal = JSON.parse(readFileSync(path.join(root, "drizzle/meta/_journal.json"), "utf8"));
  /** A migrations folder holding the journal up to `tag` (inclusive), for drizzle's own migrator. */
  const folderUpTo = tag => {
    const dir = mkdtempSync(path.join(tmpdir(), "guard-mig-")); mkdirSync(path.join(dir, "meta"));
    const entries = journal.entries.slice(0, journal.entries.findIndex(e => e.tag === tag) + 1);
    for (const e of entries) cpSync(path.join(root, "drizzle", `${e.tag}.sql`), path.join(dir, `${e.tag}.sql`));
    writeFileSync(path.join(dir, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
    cleanup.push(async () => rmSync(dir, { recursive: true, force: true }));
    return dir;
  };
  const drizzleMigrate = async (url, folder) => { const pool = mysql.createPool(url); try { await migrate(drizzle(pool), { migrationsFolder: folder }); } finally { await pool.end(); } };
  const exec = async (url, ...statements) => { const c = await mysql.createConnection(url); try { for (const s of statements) await c.query(s); } finally { await c.end(); } };

  /** Baseline 0000-0004 with legacy data, exactly as the live preview is expected to look before migrating. */
  async function baselineDatabase() {
    const s = await createScratchDatabase(base, "sakthi_rr"); cleanup.push(() => dropScratchDatabase(base, s.name));
    await drizzleMigrate(s.url, folderUpTo(BASELINE));
    await exec(s.url,
      "INSERT INTO users (openId, name) VALUES ('legacy','L')",
      "INSERT INTO workspaces (ownerUserId, name, slug) VALUES (1,'Legacy','legacy')",
      `INSERT INTO documents (workspaceId, filename, mimeType, extractedText, contentHash, pageCount) VALUES (1,'old.txt','text/plain','x','${"9".repeat(64)}',1)`,
      "INSERT INTO documentChunks (documentId, workspaceId, chunkIndex, content) VALUES (1,1,0,'முருகன் கோவில் பழநியில் உள்ளது'),(1,1,1,'palani murugan kovil')");
    const reportDir = mkdtempSync(path.join(tmpdir(), "guard-report-")); cleanup.push(async () => rmSync(reportDir, { recursive: true, force: true }));
    // the owner's backup was taken after the last write; one second of margin for TIMESTAMP rounding
    const recoveryPoint = new Date(Date.now() + 1000).toISOString();
    const guard = (mode, extra = {}) => runGuard(mode, { databaseUrl: s.url, expectedDatabase: s.name, recoveryPoint, root, reportDir, ...extra });
    return { ...s, guard };
  }

  it("full guarded sequence passes: pre (6 pending) -> migrate -> post -> second migrate -> rerun is an exact no-op", async () => {
    const db = await baselineDatabase();
    const pre = await db.guard("pre");
    expect(pre.problems).toEqual([]);
    expect(pre.report.applied).toBe(5);
    expect(pre.report.pendingTags).toEqual(journal.entries.slice(5).map(e => e.tag));
    expect(pre.report.recoveryEvidence).toMatchObject({ class: "OWNER_ATTESTED", providerVerified: false });
    expect(pre.report.rowsNewerThanRecoveryPoint).toEqual({});
    await drizzleMigrate(db.url, path.join(root, "drizzle"));
    const post = await db.guard("post");
    expect(post.problems).toEqual([]);
    expect(post.report.applied).toBe(journal.entries.length);
    await drizzleMigrate(db.url, path.join(root, "drizzle"));
    expect((await db.guard("rerun")).problems).toEqual([]);
  });

  it("refuses to migrate when rows were written after the attested recovery point", async () => {
    const db = await baselineDatabase();
    const { problems, report } = await db.guard("pre", { recoveryPoint: new Date(Date.now() - 3_600_000).toISOString() });
    expect(Object.keys(report.rowsNewerThanRecoveryPoint)).toEqual(expect.arrayContaining(["users.createdAt", "workspaces.createdAt"]));
    expect(problems.join("\n")).toMatch(/newer than the recovery point; take a fresh backup first/);
  });

  it("refuses an applied migration whose recorded hash differs from the repository SQL", async () => {
    const db = await baselineDatabase();
    await exec(db.url, `UPDATE __drizzle_migrations SET hash = '${"a".repeat(64)}' WHERE id = 3`);
    expect((await db.guard("pre")).problems.join("\n")).toMatch(/#3 \(0002_semantic_rag_provenance\) hash .* does not match/);
  });

  it("refuses unexpected journal state: a missing middle entry or an unknown extra entry", async () => {
    const gap = await baselineDatabase();
    await exec(gap.url, "DELETE FROM __drizzle_migrations WHERE id = 2");
    expect((await gap.guard("pre")).problems.length).toBeGreaterThan(0);
    const extra = await baselineDatabase();
    await exec(extra.url, `INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('${"b".repeat(64)}', 9999999999999)`);
    expect((await extra.guard("pre")).problems.join("\n")).toMatch(/has created_at 9999999999999/);
  });

  it("detects any change during the claimed no-op rerun: schema, journal or data", async () => {
    const db = await baselineDatabase();
    expect((await db.guard("pre")).problems).toEqual([]);
    await drizzleMigrate(db.url, path.join(root, "drizzle"));
    expect((await db.guard("post")).problems).toEqual([]);
    const mutations = [
      ["CREATE INDEX guard_probe_idx ON users (openId)", "DROP INDEX guard_probe_idx ON users", /indexes changed/],
      ["ALTER TABLE users ADD COLUMN guardProbe int NULL", "ALTER TABLE users DROP COLUMN guardProbe", /columns changed/],
      [`INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('${"c".repeat(64)}', 9999999999998)`, "DELETE FROM __drizzle_migrations WHERE created_at = 9999999999998", /journal changed/],
      ["INSERT INTO workspaces (ownerUserId, name, slug) VALUES (1,'Probe','probe')", "DELETE FROM workspaces WHERE slug = 'probe'", /counts changed/],
    ];
    for (const [apply, revert, reason] of mutations) {
      await exec(db.url, apply);
      expect((await db.guard("rerun")).problems.join("\n")).toMatch(reason);
      await exec(db.url, revert);
    }
    expect((await db.guard("rerun")).problems).toEqual([]);
  });

  it("detects row loss between pre and post, and refuses a non-preview database name before connecting", async () => {
    const db = await baselineDatabase();
    expect((await db.guard("pre")).problems).toEqual([]);
    await exec(db.url, "DELETE FROM documentChunks WHERE chunkIndex = 1");
    await drizzleMigrate(db.url, path.join(root, "drizzle"));
    expect((await db.guard("post")).problems.join("\n")).toMatch(/table documentChunks lost rows: 2 -> 1/);
    expect((await db.guard("pre", { expectedDatabase: "sakthiai_preview" })).problems.join("\n")).toMatch(/unexpected database/);
  });
});
