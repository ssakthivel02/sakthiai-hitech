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
import { migrationObjects, runGuard } from "../scripts/preview-migration-guard.mjs";

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
    // existing rows are classified, not treated as a failure
    expect(pre.report.classification).toMatchObject({ state: "CONSISTENT_PREFIX", orphanPending: [], missingApplied: [], unmanagedTables: [], unmanagedObjects: [] });
    expect(pre.report.classification.tablesWithRows.map(r => r.table).sort()).toEqual(["documentChunks", "documents", "users", "workspaces"]);
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

  /** A scratch database in an arbitrary state (built by `setup`), with the same guard wiring as baselineDatabase. */
  async function stateDatabase(setup) {
    const s = await createScratchDatabase(base, "sakthi_rr"); cleanup.push(() => dropScratchDatabase(base, s.name));
    await setup(s.url);
    const reportDir = mkdtempSync(path.join(tmpdir(), "guard-report-")); cleanup.push(async () => rmSync(reportDir, { recursive: true, force: true }));
    const recoveryPoint = new Date(Date.now() + 1000).toISOString();
    return { ...s, guard: (mode, extra = {}) => runGuard(mode, { databaseUrl: s.url, expectedDatabase: s.name, recoveryPoint, root, reportDir, ...extra }) };
  }
  const statements = tag => readFileSync(path.join(root, "drizzle", `${tag}.sql`), "utf8").split("--> statement-breakpoint").map(x => x.trim()).filter(Boolean);
  const tagOf = prefix => journal.entries.find(e => e.tag.startsWith(prefix)).tag;

  it("ground truth: every real-migrator prefix 0..11 classifies clean (EMPTY or CONSISTENT_PREFIX, nothing missing or unmanaged)", async () => {
    for (let n = 0; n <= journal.entries.length; n++) {
      const db = await stateDatabase(url => (n ? drizzleMigrate(url, folderUpTo(journal.entries[n - 1].tag)) : Promise.resolve()));
      const pre = await db.guard("pre");
      expect(pre.problems, `prefix ${n}`).toEqual([]);
      expect(pre.report.classification, `prefix ${n}`).toMatchObject({ state: n ? "CONSISTENT_PREFIX" : "EMPTY", missingApplied: [], orphanPending: [], unmanagedObjects: [], unmanagedTables: [] });
    }
  });

  it("classifies an empty target as EMPTY with every migration pending, and an unrelated table as unmanaged (not a failure)", async () => {
    const db = await stateDatabase(url => exec(url, "CREATE TABLE ops_note (id int PRIMARY KEY)", "INSERT INTO ops_note VALUES (1)"));
    const pre = await db.guard("pre");
    expect(pre.problems).toEqual([]);
    expect(pre.report.classification).toMatchObject({ state: "EMPTY", unmanagedTables: ["ops_note"], tablesWithRows: [{ table: "ops_note", rows: 1 }] });
    expect(pre.report.classification.pendingTags).toEqual(journal.entries.map(e => e.tag));
  });

  it("refuses orphan schema: managed tables and rows present but no migration journal (manual DDL or drizzle-kit push)", async () => {
    const db = await stateDatabase(url => exec(url, ...statements(tagOf("0000")), ...statements(tagOf("0001")), "INSERT INTO users (openId, name) VALUES ('legacy','L')"));
    const pre = await db.guard("pre");
    expect(pre.report.classification.state).toBe("ORPHAN_OR_PARTIAL");
    expect(pre.report.classification.tablesWithRows).toEqual([{ table: "users", rows: 1 }]);
    expect(pre.problems.join("\n")).toMatch(/table users from pending migration 0000_\w+ already exists/);
    expect(pre.report.classification.orphanPending.filter(o => o.kind === "table")).toHaveLength(8);
  });

  it("refuses an interrupted CREATE TABLE migration: journal at 0002 but 5 of 0003's 12 tables exist", async () => {
    const db = await stateDatabase(async url => { await drizzleMigrate(url, folderUpTo(tagOf("0002"))); await exec(url, ...statements(tagOf("0003")).slice(0, 5)); });
    const pre = await db.guard("pre");
    expect(pre.report.applied).toBe(3);
    expect(pre.report.classification.state).toBe("ORPHAN_OR_PARTIAL");
    expect(new Set(pre.report.classification.orphanPending.map(o => o.tag))).toEqual(new Set([tagOf("0003")]));
    expect(pre.report.classification.orphanPending.filter(o => o.kind === "table")).toHaveLength(5);
  });

  it("refuses interrupted ALTER/INDEX migrations: 3 of 0002's 7 ADD COLUMNs, or 0006's column + 2 of its 7 indexes", async () => {
    const partial0002 = await stateDatabase(async url => { await drizzleMigrate(url, folderUpTo(tagOf("0001"))); await exec(url, ...statements(tagOf("0002")).slice(0, 3)); });
    const a = await partial0002.guard("pre");
    expect(a.report.classification.state).toBe("ORPHAN_OR_PARTIAL");
    expect(a.report.classification.orphanPending).toHaveLength(3);
    expect(a.report.classification.orphanPending.every(o => o.kind === "column" && o.tag === tagOf("0002"))).toBe(true);
    const partial0006 = await stateDatabase(async url => { await drizzleMigrate(url, folderUpTo(tagOf("0005"))); await exec(url, ...statements(tagOf("0006")).slice(0, 3)); });
    const b = await partial0006.guard("pre");
    expect(b.report.classification.state).toBe("ORPHAN_OR_PARTIAL");
    expect(b.report.classification.orphanPending.map(o => o.kind).sort()).toEqual(["column", "index", "index"]);
  });

  it("refuses schema drift of an ADD COLUMN and of a base CREATE TABLE column; post also re-checks after migrating", async () => {
    const db = await baselineDatabase();
    await exec(db.url, "ALTER TABLE documents DROP INDEX documents_workspace_hash_idx", "ALTER TABLE documents DROP COLUMN contentHash", "ALTER TABLE users DROP COLUMN email");
    const pre = await db.guard("pre");
    expect(pre.report.classification.state).toBe("DRIFT_MISSING");
    const text = pre.problems.join("\n");
    expect(text).toMatch(/column documents\.contentHash from applied migration 0002_\w+ is missing/);
    expect(text).toMatch(/column users\.email from applied migration 0000_\w+ is missing/);
    expect(text).toMatch(/index documents\.documents_workspace_hash_idx from applied migration 0002_\w+ is missing/);
    await drizzleMigrate(db.url, path.join(root, "drizzle"));
    expect((await db.guard("post")).problems.join("\n")).toMatch(/column users\.email .* is missing/);
  });

  it("reports unexpected columns/indexes on managed tables without failing, but refuses a name that collides with a pending index", async () => {
    const extra = await baselineDatabase();
    await exec(extra.url, "ALTER TABLE users ADD COLUMN ops_flag int", "CREATE INDEX ops_users_email_idx ON users (email)");
    const ok = await extra.guard("pre");
    expect(ok.problems).toEqual([]);
    expect(ok.report.classification.state).toBe("CONSISTENT_PREFIX");
    expect(ok.report.classification.unmanagedObjects.sort()).toEqual(["column users.ops_flag", "index users.ops_users_email_idx"]);
    const pendingIndex = migrationObjects(root).find(o => o.tag === tagOf("0006")).indexes.find(i => i.startsWith("documentChunks."));
    const collide = await baselineDatabase();
    await exec(collide.url, `CREATE INDEX \`${pendingIndex.split(".")[1]}\` ON documentChunks (workspaceId)`);
    const bad = await collide.guard("pre");
    expect(bad.report.classification.state).toBe("ORPHAN_OR_PARTIAL");
    expect(bad.problems.join("\n")).toMatch(new RegExp(`index ${pendingIndex.replace(".", "\\.")} from pending migration 0006_\\w+ already exists`));
  });

  it("grants mode: inspect needs a SELECT-only principal, migrate a least-privilege migrator; anything broader fails before any write", async () => {
    const db = await stateDatabase(url => drizzleMigrate(url, folderUpTo(tagOf("0004"))));
    const suffix = Math.random().toString(36).slice(2, 8);
    const principal = async (name, grants) => {
      const user = `${name}_${suffix}`, pw = `pw-${suffix}`;
      await exec(base, `CREATE USER '${user}'@'%' IDENTIFIED BY '${pw}'`, ...grants.map(gr => `GRANT ${gr} TO '${user}'@'%'`));
      cleanup.push(() => exec(base, `DROP USER IF EXISTS '${user}'@'%'`));
      const u = new URL(db.url); u.username = user; u.password = pw;
      return u.toString();
    };
    const on = `\`${db.name}\`.*`;
    const inspectUrl = await principal("gi", [`SELECT ON ${on}`]);
    const migratorUrl = await principal("gm", [`SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX ON ${on}`]);
    const appUrl = await principal("ga", [`SELECT, INSERT, UPDATE, DELETE ON ${on}`]);
    const dropUrl = await principal("gd", [`SELECT, INSERT, UPDATE, CREATE, ALTER, INDEX, DROP ON ${on}`]);
    const globalUrl = await principal("gg", ["SELECT ON *.*"]);
    const grants = (databaseUrl, role) => db.guard("grants", { databaseUrl, role });

    const ok = await grants(inspectUrl, "inspect");
    expect(ok.problems).toEqual([]);
    expect(ok.report).toMatchObject({ role: "inspect", privileges: ["SELECT"] });
    expect((await grants(migratorUrl, "migrate")).problems).toEqual([]);
    for (const [url, role] of [[migratorUrl, "inspect"], [appUrl, "inspect"], [appUrl, "migrate"], [dropUrl, "migrate"], [globalUrl, "inspect"], [inspectUrl, "migrate"], [inspectUrl, undefined]]) {
      expect((await grants(url, role)).problems.length, `${new URL(url).username} as ${role}`).toBeGreaterThan(0);
    }
    // the inspect principal really cannot write, so inspect mode is read-only by privilege as well as by workflow
    await expect(exec(inspectUrl, "CREATE TABLE should_fail (id int)")).rejects.toThrow(/denied/);
    await expect(exec(inspectUrl, "INSERT INTO users (openId) VALUES ('x')")).rejects.toThrow(/denied/);
  });

  it("recovery check covers DATETIME createdAt/updatedAt (durableTasks, mcpConnectors, upload sessions ...)", async () => {
    const db = await stateDatabase(url => drizzleMigrate(url, folderUpTo(tagOf("0010"))));
    // a row written AFTER the attested recovery point, in a DATETIME(3) table, stored as UTC like the app writes it
    const later = new Date(Date.now() + 60_000).toISOString().slice(0, 23).replace("T", " ");
    await exec(db.url, `INSERT INTO durableTasks (id, workspaceId, type, inputHash, inputJson, createdAt, updatedAt) VALUES ('11111111-1111-1111-1111-111111111111', 1, 't', '${"0".repeat(64)}', '{}', '${later}', '${later}')`);
    const pre = await db.guard("pre");
    expect(pre.report.rowsNewerThanRecoveryPoint).toMatchObject({ "durableTasks.createdAt": 1, "durableTasks.updatedAt": 1 });
    expect(pre.problems.join("\n")).toMatch(/durableTasks\.createdAt are newer than the recovery point/);
  });

  it("reports tables whose rows the recovery check cannot date, without failing on them", async () => {
    const db = await baselineDatabase();
    const pre = await db.guard("pre");
    expect(pre.problems).toEqual([]);
    expect(pre.report.recoveryUncoveredTables).toEqual([{ table: "documentChunks", rows: 2 }]);
  });
});
