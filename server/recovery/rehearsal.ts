import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import mysql, { type Connection } from "mysql2/promise";
import { assertSafeTarget } from "../testing/mysqlTestDb";

/**
 * LOCAL backup / restore / upgrade rehearsal helpers. They operate ONLY on a throwaway local MySQL-compatible server:
 * every entry point validates the URL with the same guard the integration harness uses (managed hosts such as Aiven,
 * Render, RDS and Azure are refused; non-loopback hosts are refused unless MYSQL_TEST_ALLOW_REMOTE=1 for a disposable server).
 *
 * The backup is a logical export (schema via SHOW CREATE TABLE, rows as typed JSON) taken inside ONE consistent-snapshot
 * transaction, with a per-table row count and SHA-256 over the canonical rows in primary-key order. Restore refuses
 * non-empty targets, the source database itself, corrupted backups and backups from a newer schema than this build knows,
 * then re-reads the restored database and verifies every table's count and checksum.
 *
 * Migrations are FORWARD-ONLY. There is no schema downgrade; "rollback" means restoring a pre-migration backup (data written
 * after that backup is lost, i.e. the RPO equals the age of the backup).
 */
export const BACKUP_FORMAT = "sakthiai.logical-backup/v1";
type Json = null | number | string | { b64: string };
export type BackupTable = { name: string; createSql: string; columns: string[]; primaryKey: string[]; rows: Json[][]; rowCount: number; sha256: string };
export type Backup = { format: typeof BACKUP_FORMAT; manifest: { sourceDatabase: string; engineVersion: string; createdAt: string; migrationTags: string[]; tables: Array<{ name: string; rowCount: number; sha256: string }>; digest: string }; tables: BackupTable[] };
export type VerifyEntry = { table: string; expectedRows: number; actualRows: number; expectedSha256: string; actualSha256: string | null; ok: boolean };
export type VerifyResult = { ok: boolean; tables: VerifyEntry[]; mismatches: string[] };

export class RehearsalRefused extends Error { constructor(public readonly reason: string) { super(`refused: ${reason}`); this.name = "RehearsalRefused"; } }
export class RestoreFailed extends Error { constructor(message: string) { super(message); this.name = "RestoreFailed"; } }

const qi = (name: string) => `\`${name.replace(/`/g, "``")}\``;
const sha = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");

export function parseTarget(urlText: string): { url: URL; host: string; port: number; user: string; password: string } {
  const url = new URL(urlText);
  try { assertSafeTarget(url); } catch (error) { throw new RehearsalRefused((error as Error).message); }
  return { url, host: url.hostname, port: url.port ? Number(url.port) : 3306, user: decodeURIComponent(url.username), password: decodeURIComponent(url.password) };
}
const connect = async (urlText: string, database?: string): Promise<Connection> => {
  const t = parseTarget(urlText);
  const name = database ?? (t.url.pathname.replace(/^\//, "") || undefined);
  const conn = await mysql.createConnection({ host: t.host, port: t.port, user: t.user, password: t.password, database: name, dateStrings: true, supportBigNumbers: true, bigNumberStrings: true, multipleStatements: false });
  await conn.query("SET time_zone = '+00:00'");
  return conn;
};
export const databaseNameOf = (urlText: string) => new URL(urlText).pathname.replace(/^\//, "");
export const withDatabase = (urlText: string, name: string) => { const u = new URL(urlText); u.pathname = `/${name}`; return u.toString(); };

export async function createScratchDatabase(baseUrl: string, prefix = "sakthi_rr"): Promise<{ name: string; url: string }> {
  const conn = await connect(baseUrl, undefined as unknown as string);
  try {
    const name = `${prefix}_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
    await conn.query(`CREATE DATABASE ${qi(name)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    return { name, url: withDatabase(baseUrl, name) };
  } finally { await conn.end(); }
}
export async function dropScratchDatabase(baseUrl: string, name: string): Promise<void> {
  if (!/^sakthi_(rr|it)_[a-z0-9_]+$/.test(name)) throw new RehearsalRefused(`refusing to drop non-scratch database ${name}`);
  const conn = await connect(baseUrl, undefined as unknown as string);
  try { await conn.query(`DROP DATABASE IF EXISTS ${qi(name)}`); } finally { await conn.end(); }
}

const encode = (value: unknown): Json => {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value)) return { b64: value.toString("base64") };
  if (typeof value === "number" || typeof value === "string") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  throw new Error(`unsupported value type ${typeof value}`);
};
const decode = (value: Json): unknown => (value && typeof value === "object" ? Buffer.from(value.b64, "base64") : value);
const rowsHash = (rows: Json[][]) => { const h = createHash("sha256"); for (const row of rows) h.update(JSON.stringify(row)).update("\n"); return h.digest("hex"); };

type Journal = { entries: Array<{ idx: number; tag: string }> };
export const readJournal = (root = process.cwd()): Journal => JSON.parse(readFileSync(path.join(root, "drizzle/meta/_journal.json"), "utf8"));
const statementsOf = (tag: string, root: string) => readFileSync(path.join(root, "drizzle", `${tag}.sql`), "utf8").split("--> statement-breakpoint").map(p => p.trim()).filter(Boolean);

/** Applies journal migrations in order. `upTo` (inclusive) / `after` (exclusive) select a slice. Forward-only. */
export async function applyMigrations(dbUrl: string, options: { upTo?: string; after?: string; root?: string } = {}): Promise<string[]> {
  const root = options.root ?? process.cwd(); const tags = readJournal(root).entries.map(e => e.tag); const applied: string[] = [];
  const start = options.after ? tags.indexOf(options.after) + 1 : 0; if (options.after && start === 0) throw new RehearsalRefused(`unknown migration ${options.after}`);
  const end = options.upTo ? tags.indexOf(options.upTo) + 1 : tags.length; if (options.upTo && end === 0) throw new RehearsalRefused(`unknown migration ${options.upTo}`);
  const conn = await connect(dbUrl);
  try { for (const tag of tags.slice(start, end)) { for (const statement of statementsOf(tag, root)) await conn.query(statement); applied.push(tag); } } finally { await conn.end(); }
  return applied;
}

async function tableList(conn: Connection, db: string): Promise<string[]> {
  const [rows] = await conn.query("SELECT TABLE_NAME AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME", [db]);
  return (rows as Array<{ n: string }>).map(r => r.n);
}
async function describeTable(conn: Connection, db: string, table: string) {
  const [cols] = await conn.query("SELECT COLUMN_NAME AS c, COLUMN_KEY AS k, ORDINAL_POSITION AS o FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION", [db, table]);
  const columns = (cols as Array<{ c: string; k: string }>).map(r => r.c);
  const [pk] = await conn.query("SELECT COLUMN_NAME AS c FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'PRIMARY' ORDER BY ORDINAL_POSITION", [db, table]);
  return { columns, primaryKey: (pk as Array<{ c: string }>).map(r => r.c) };
}
/** Rows in canonical (primary-key, else all-column) order as typed JSON; `columns` lets callers hash only a column subset. */
async function readRows(conn: Connection, table: string, columns: string[], order: string[]): Promise<Json[][]> {
  const [rows] = await conn.query({ sql: `SELECT ${columns.map(qi).join(", ")} FROM ${qi(table)} ORDER BY ${(order.length ? order : columns).map(qi).join(", ")}`, rowsAsArray: true });
  return (rows as unknown[][]).map(r => r.map(encode));
}

export async function backupDatabase(dbUrl: string, options: { migrationTags: string[] }): Promise<Backup> {
  const dbName = databaseNameOf(dbUrl); if (!dbName) throw new RehearsalRefused("database name required in URL");
  const conn = await connect(dbUrl);
  try {
    await conn.query("SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    await conn.query("START TRANSACTION WITH CONSISTENT SNAPSHOT");
    const [[v]] = (await conn.query("SELECT VERSION() AS v")) as unknown as [[{ v: string }]];
    const tables: BackupTable[] = [];
    for (const name of await tableList(conn, dbName)) {
      const { columns, primaryKey } = await describeTable(conn, dbName, name);
      const [[c]] = (await conn.query(`SHOW CREATE TABLE ${qi(name)}`)) as unknown as [[Record<string, string>]];
      const rows = await readRows(conn, name, columns, primaryKey);
      tables.push({ name, createSql: c["Create Table"], columns, primaryKey, rows, rowCount: rows.length, sha256: rowsHash(rows) });
    }
    await conn.query("ROLLBACK");
    const summary = tables.map(t => ({ name: t.name, rowCount: t.rowCount, sha256: t.sha256 }));
    const manifest = { sourceDatabase: dbName, engineVersion: v.v, createdAt: new Date().toISOString(), migrationTags: [...options.migrationTags], tables: summary, digest: sha(JSON.stringify({ tags: options.migrationTags, summary, schema: tables.map(t => t.createSql) })) };
    return { format: BACKUP_FORMAT, manifest, tables };
  } finally { await conn.end(); }
}

export const writeBackup = (file: string, backup: Backup) => writeFileSync(file, JSON.stringify(backup));
export const readBackup = (file: string): Backup => JSON.parse(readFileSync(file, "utf8")) as Backup;

/** Integrity of the backup itself (independent of any database): row hashes, counts and manifest digest. */
export function checkBackupIntegrity(backup: Backup): string[] {
  const problems: string[] = [];
  if (backup.format !== BACKUP_FORMAT) problems.push(`unknown format ${String(backup.format)}`);
  for (const t of backup.tables) {
    if (t.rows.length !== t.rowCount) problems.push(`${t.name}: row count ${t.rows.length} != ${t.rowCount}`);
    if (rowsHash(t.rows) !== t.sha256) problems.push(`${t.name}: row checksum mismatch`);
    const m = backup.manifest.tables.find(x => x.name === t.name);
    if (!m || m.sha256 !== t.sha256 || m.rowCount !== t.rowCount) problems.push(`${t.name}: manifest disagrees`);
  }
  if (backup.manifest.tables.length !== backup.tables.length) problems.push("manifest table list differs");
  const digest = sha(JSON.stringify({ tags: backup.manifest.migrationTags, summary: backup.manifest.tables, schema: backup.tables.map(t => t.createSql) }));
  if (digest !== backup.manifest.digest) problems.push("manifest digest mismatch");
  return problems;
}

export async function verifyAgainstBackup(dbUrl: string, backup: Backup): Promise<VerifyResult> {
  const dbName = databaseNameOf(dbUrl); const conn = await connect(dbUrl);
  try {
    const present = new Set(await tableList(conn, dbName)); const tables: VerifyEntry[] = []; const mismatches: string[] = [];
    for (const t of backup.tables) {
      if (!present.has(t.name)) { tables.push({ table: t.name, expectedRows: t.rowCount, actualRows: 0, expectedSha256: t.sha256, actualSha256: null, ok: false }); mismatches.push(`${t.name}: missing`); continue; }
      const { columns } = await describeTable(conn, dbName, t.name);
      let rows: Json[][] | null = null; let error: string | null = null;
      // Hash only the backed-up columns so a later, additive migration does not look like data loss; dropped columns do.
      try { rows = await readRows(conn, t.name, t.columns, t.primaryKey); } catch (e) { error = (e as Error).message; }
      const ok = rows !== null && rows.length === t.rowCount && rowsHash(rows) === t.sha256 && t.columns.every(c => columns.includes(c));
      tables.push({ table: t.name, expectedRows: t.rowCount, actualRows: rows?.length ?? 0, expectedSha256: t.sha256, actualSha256: rows ? rowsHash(rows) : null, ok });
      if (!ok) mismatches.push(`${t.name}: ${error ? `unreadable (${error.slice(0, 60)})` : rows && rows.length !== t.rowCount ? `rows ${rows.length} != ${t.rowCount}` : "checksum differs"}`);
    }
    return { ok: mismatches.length === 0, tables, mismatches };
  } finally { await conn.end(); }
}

export async function restoreDatabase(targetUrl: string, backup: Backup, options: { root?: string; failAfterRows?: number; allowSameName?: boolean } = {}): Promise<VerifyResult> {
  const target = databaseNameOf(targetUrl); if (!target) throw new RehearsalRefused("target database name required");
  if (target === backup.manifest.sourceDatabase && !options.allowSameName) throw new RehearsalRefused("target is the backup's source database");
  const integrity = checkBackupIntegrity(backup); if (integrity.length) throw new RehearsalRefused(`backup integrity check failed: ${integrity.slice(0, 3).join("; ")}`);
  const known = readJournal(options.root).entries.map(e => e.tag); const tags = backup.manifest.migrationTags;
  if (!tags.length || tags.some((t, i) => known[i] !== t)) throw new RehearsalRefused("backup migrations are not a prefix of this build's journal (newer or unknown schema)");
  const conn = await connect(targetUrl);
  try {
    if ((await tableList(conn, target)).length) throw new RehearsalRefused("target database is not empty");
    await conn.query("SET FOREIGN_KEY_CHECKS = 0");
    let inserted = 0;
    try {
      for (const t of backup.tables) {
        await conn.query(t.createSql);
        for (let i = 0; i < t.rows.length; i += 200) {
          const batch = t.rows.slice(i, i + 200).map(r => r.map(decode));
          await conn.query(`INSERT INTO ${qi(t.name)} (${t.columns.map(qi).join(", ")}) VALUES ?`, [batch]);
          inserted += batch.length;
          if (options.failAfterRows !== undefined && inserted >= options.failAfterRows) throw new Error("injected restore failure");
        }
      }
    } catch (error) { throw new RestoreFailed(`restore interrupted after ${inserted} rows: ${(error as Error).message}`); }
    await conn.query("SET FOREIGN_KEY_CHECKS = 1");
  } finally { await conn.end(); }
  return verifyAgainstBackup(targetUrl, backup);
}
