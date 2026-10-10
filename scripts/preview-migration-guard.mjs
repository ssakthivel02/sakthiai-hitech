#!/usr/bin/env node
// Read-only guard around `pnpm db:push` for the non-disposable preview database (used by preview-db-setup.yml).
//   attest: RECOVERY_POINT must be a real, non-future UTC instant (YYYY-MM-DDTHH:MM[:SS[.ffffff]]Z). No database access.
//   pre:    applied __drizzle_migrations rows must be an exact in-order prefix of the journal, matching the Drizzle
//           migrator's own format (hash = sha256 of drizzle/<tag>.sql, created_at = journal `when`); no row may be newer
//           than the attested recovery point; the live schema must match what that prefix creates (classifySchema:
//           no object of a pending migration may exist, none of an applied one may be missing); snapshot schema +
//           journal + row counts. Existing rows and unmanaged objects are reported, never failures in themselves.
//   post:   every journal entry applied (same checks); no table, column or row lost since `pre`; snapshot.
//   rerun:  after a second `db:push`, journal rows, schema and row counts must be identical to the `post` snapshot.
//   grants: the connected principal's privileges must match PREVIEW_DB_ROLE exactly as checkPrincipalGrants defines
//           (inspect = SELECT only; migrate = the DDL/DML a migration needs, never DROP, GRANT or global privileges).
// Recovery evidence is OWNER_ATTESTED: a typed timestamp is never treated as a provider-verified backup.
// Never writes to the database. TLS is verified whenever DATABASE_CA_CERT_B64 is set (the workflow requires it).
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import mysql from "mysql2/promise";

export const RECOVERY_EVIDENCE_CLASS = "OWNER_ATTESTED";
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const RECOVERY_POINT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?Z$/;

/** Strict UTC instant: real calendar date, valid clock time, explicit Z, not in the future. */
export function parseRecoveryPoint(text, now = new Date()) {
  const m = RECOVERY_POINT.exec(String(text ?? "").trim());
  if (!m) return { ok: false, problems: ["recovery_point must be a UTC timestamp like 2026-10-05T01:10:00Z"] };
  const [y, mo, d, h, mi, s = "0", frac = "0"] = m.slice(1);
  const ms = Number(frac.padEnd(3, "0").slice(0, 3));
  const epochMs = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s, ms);
  const back = new Date(epochMs);
  if (back.getUTCFullYear() !== +y || back.getUTCMonth() !== +mo - 1 || back.getUTCDate() !== +d || back.getUTCHours() !== +h || back.getUTCMinutes() !== +mi || back.getUTCSeconds() !== +s) {
    return { ok: false, problems: [`recovery_point ${text} is not a real UTC date/time`] };
  }
  if (epochMs > now.getTime() + MAX_CLOCK_SKEW_MS) return { ok: false, problems: [`recovery_point ${text} is in the future`] };
  return { ok: true, epochMs, iso: back.toISOString(), problems: [] };
}

/** The journal exactly as the Drizzle migrator records it. */
export function expectedJournal(root = process.cwd()) {
  const journal = JSON.parse(readFileSync(path.join(root, "drizzle/meta/_journal.json"), "utf8"));
  return journal.entries.map(e => ({
    tag: e.tag,
    when: Number(e.when),
    hash: createHash("sha256").update(readFileSync(path.join(root, "drizzle", `${e.tag}.sql`)).toString()).digest("hex"),
  }));
}

/** Applied rows (ordered by id) must be an exact prefix of the expected journal; `complete` also requires all of it. */
export function checkJournal(applied, expected, { complete = false } = {}) {
  const problems = [];
  if (applied.length > expected.length) problems.push(`${applied.length} applied migrations but the journal has only ${expected.length}`);
  applied.forEach((row, i) => {
    const want = expected[i];
    if (!want) return;
    if (Number(row.created_at) !== want.when) problems.push(`applied migration #${i + 1} has created_at ${row.created_at}; journal ${want.tag} expects ${want.when}`);
    if (row.hash !== want.hash) problems.push(`applied migration #${i + 1} (${want.tag}) hash ${String(row.hash).slice(0, 12)}… does not match the repository SQL ${want.hash.slice(0, 12)}…`);
  });
  if (complete && applied.length !== expected.length) problems.push(`expected ${expected.length} applied migrations, found ${applied.length}`);
  return problems;
}

/**
 * Objects each migration creates, read statically from drizzle/<tag>.sql. The migrations are additive only
 * (CREATE TABLE, ALTER TABLE ... ADD COLUMN / ADD CONSTRAINT / MODIFY COLUMN, CREATE INDEX); a statement of any other
 * form throws, so a future migration cannot silently escape classification. Keys are "table", "table.column" and
 * "table.index" (PRIMARY KEY -> index "PRIMARY"; a named UNIQUE constraint -> an index of that name).
 */
export function migrationObjects(root = process.cwd()) {
  const journal = JSON.parse(readFileSync(path.join(root, "drizzle/meta/_journal.json"), "utf8"));
  return journal.entries.map(e => {
    const tables = [], columns = [], indexes = [];
    const sql = readFileSync(path.join(root, "drizzle", `${e.tag}.sql`), "utf8");
    for (const stmt of sql.split("--> statement-breakpoint").map(s => s.trim()).filter(Boolean)) {
      let m;
      if ((m = /^CREATE TABLE\s+`([^`]+)`\s*\(([\s\S]*)\)\s*;?$/i.exec(stmt))) {
        const [, table, body] = m;
        tables.push(table);
        for (const line of body.split("\n").map(l => l.trim()).filter(Boolean)) {
          let d;
          if ((d = /^`([^`]+)`\s/.exec(line))) columns.push(`${table}.${d[1]}`);
          else if (/^CONSTRAINT\s+`[^`]+`\s+PRIMARY KEY\b/i.test(line)) indexes.push(`${table}.PRIMARY`);
          else if ((d = /^CONSTRAINT\s+`([^`]+)`\s+UNIQUE\b/i.exec(line))) indexes.push(`${table}.${d[1]}`);
          else throw new Error(`${e.tag}: unrecognised CREATE TABLE line for ${table}: ${line}`);
        }
      } else if ((m = /^ALTER TABLE\s+`([^`]+)`\s+([\s\S]*?);?$/i.exec(stmt))) {
        const [, table, clauses] = m;
        for (const clause of clauses.split(/,\s*\n/).map(c => c.trim()).filter(Boolean)) {
          let d;
          if ((d = /^ADD COLUMN\s+`([^`]+)`/i.exec(clause))) columns.push(`${table}.${d[1]}`);
          else if ((d = /^ADD CONSTRAINT\s+`([^`]+)`\s+UNIQUE\b/i.exec(clause))) indexes.push(`${table}.${d[1]}`);
          else if (/^MODIFY COLUMN\s+`[^`]+`/i.test(clause)) continue; // type change of an existing column: no new object
          else throw new Error(`${e.tag}: unrecognised ALTER TABLE clause for ${table}: ${clause}`);
        }
      } else if ((m = /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+`([^`]+)`\s+ON\s+`([^`]+)`/i.exec(stmt))) {
        indexes.push(`${m[2]}.${m[1]}`);
      } else {
        throw new Error(`${e.tag}: unrecognised migration statement (classification assumes additive DDL): ${stmt.slice(0, 80)}`);
      }
    }
    return { tag: e.tag, tables, columns, indexes };
  });
}

/**
 * Classifies the live schema against the applied journal prefix instead of trusting the journal alone:
 *   EMPTY             no managed table and no journal row: every migration is pending.
 *   CONSISTENT_PREFIX every table, column and index the applied prefix creates is present, and nothing any pending
 *                     migration creates exists yet.
 *   ORPHAN_OR_PARTIAL some object of a pending migration already exists (unrecorded or interrupted migration, manual
 *                     DDL, `drizzle-kit push`); applying would fail on "already exists" mid-migration -> problem.
 *   DRIFT_MISSING     the journal records a migration but some object it creates is absent -> problem.
 * Reported, never failures: tables no migration creates, extra columns/indexes on managed tables whose names collide
 * with nothing pending, and per-table row counts (the migrations are additive; the recovery-point check covers rows).
 * Names compare case-insensitively: MySQL column and index names always are, and table names are on
 * lower_case_table_names=1 servers.
 */
export function classifySchema(snapshot, root = process.cwd()) {
  const objects = migrationObjects(root);
  const k = name => name.toLowerCase();
  const applied = objects.slice(0, snapshot.journal.length), pending = objects.slice(snapshot.journal.length);
  const liveTables = snapshot.tables.filter(t => k(t) !== "__drizzle_migrations");
  // one name space per kind: MySQL auto-names a UNIQUE(col) index after the column, so "t.x" can be both
  const live = {
    table: new Map(liveTables.map(t => [k(t), t])),
    column: new Map(snapshot.columns.map(c => c.split(" ")[0]).map(n => [k(n), n])),
    index: new Map(snapshot.indexes.map(i => i.split("#")[0]).map(n => [k(n), n])),
  };
  const field = { table: "tables", column: "columns", index: "indexes" };
  const list = (entries, kind) => entries.flatMap(o => o[field[kind]].map(name => ({ tag: o.tag, kind, name })));
  const flatten = entries => [...list(entries, "table"), ...list(entries, "column"), ...list(entries, "index")];
  const exists = o => live[o.kind].has(k(o.name));
  const explained = flatten(applied), pendingObjects = flatten(pending);
  const missingApplied = explained.filter(o => !exists(o));
  const orphanPending = pendingObjects.filter(exists);
  const managed = { table: new Set(), column: new Set(), index: new Set() };
  for (const o of flatten(objects)) managed[o.kind].add(k(o.name));
  const unmanagedTables = liveTables.filter(t => !managed.table.has(k(t)));
  const unmanagedObjects = ["column", "index"].flatMap(kind => [...live[kind].entries()]
    .filter(([key]) => managed.table.has(key.split(".")[0]) && !managed[kind].has(key))
    .map(([, name]) => `${kind} ${name}`));
  const managedTables = managed.table;
  const tablesWithRows = Object.entries(snapshot.counts).filter(([, n]) => n > 0).map(([table, rows]) => ({ table, rows }));
  const managedPresent = liveTables.some(t => managedTables.has(k(t)));
  const state = missingApplied.length ? "DRIFT_MISSING" : orphanPending.length ? "ORPHAN_OR_PARTIAL"
    : !managedPresent && snapshot.journal.length === 0 ? "EMPTY" : "CONSISTENT_PREFIX";
  const problems = [
    ...missingApplied.map(o => `${o.kind} ${o.name} from applied migration ${o.tag} is missing (schema drift)`),
    ...orphanPending.map(o => `${o.kind} ${o.name} from pending migration ${o.tag} already exists (unrecorded or partial migration); reconcile before migrating`),
  ];
  return { state, appliedTags: applied.map(o => o.tag), pendingTags: pending.map(o => o.tag), unmanagedTables, unmanagedObjects, tablesWithRows, missingApplied, orphanPending, problems };
}

export const PRINCIPAL_ROLES = {
  // inspect must be read-only by privilege, not only by workflow logic
  inspect: { required: ["SELECT"], allowed: ["SELECT"] },
  // what drizzle-kit migrate + the search-text backfill need; DELETE tolerated, DROP/GRANT/global never
  migrate: { required: ["SELECT", "INSERT", "UPDATE", "CREATE", "ALTER", "INDEX"], allowed: ["SELECT", "INSERT", "UPDATE", "DELETE", "CREATE", "ALTER", "INDEX"] },
};

/**
 * Fail-closed check of SHOW GRANTS output for the connected principal. Accepted lines: `GRANT USAGE ON *.*` and
 * database-level grants on exactly the target database whose privileges fit the role. Anything else (global or
 * dynamic privileges, other databases, wildcards, table/column/proxy/role grants, WITH GRANT OPTION, ALL) is a problem.
 */
export function checkPrincipalGrants(lines, role, database) {
  const spec = PRINCIPAL_ROLES[role];
  if (!spec) return { privileges: [], problems: [`unknown PREVIEW_DB_ROLE ${role || "<none>"}; expected one of ${Object.keys(PRINCIPAL_ROLES).join(", ")}`] };
  const problems = [], held = new Set();
  for (const raw of lines) {
    const line = String(raw).trim();
    if (/^GRANT USAGE ON \*\.\* TO /i.test(line)) continue;
    if (/WITH GRANT OPTION/i.test(line)) { problems.push(`grant option is not allowed: ${line}`); continue; }
    const m = /^GRANT (.+?) ON `((?:[^`]|``)+)`\.\* TO /i.exec(line);
    if (!m) { problems.push(`unexpected grant (only database-level grants on ${database} are allowed): ${line}`); continue; }
    const db = m[2].replace(/\\([_%])/g, "$1");
    if (/[%]/.test(db) || db !== database) { problems.push(`grant on another or wildcard database ${m[2]} is not allowed`); continue; }
    for (const priv of m[1].split(",").map(p => p.trim().toUpperCase())) {
      if (!spec.allowed.includes(priv)) problems.push(`privilege ${priv} on ${database} is not allowed for role ${role}`);
      else held.add(priv);
    }
  }
  for (const priv of spec.required) if (!held.has(priv)) problems.push(`role ${role} requires ${priv} on ${database}`);
  return { privileges: [...held].sort(), problems };
}

/** Tables holding rows that the recovery-point check cannot see (no createdAt/updatedAt TIMESTAMP or DATETIME column). */
export function recoveryUncoveredTables(snapshot) {
  const covered = new Set(snapshot.columns
    .filter(c => /^[^.]+\.(createdAt|updatedAt) (timestamp|datetime)/i.test(c))
    .map(c => c.split(".")[0].toLowerCase()));
  return Object.entries(snapshot.counts).filter(([t, n]) => n > 0 && !covered.has(t.toLowerCase())).map(([table, rows]) => ({ table, rows }));
}

const q = async (conn, sql, params = []) => (await conn.query(sql, params))[0];

/** Journal rows, columns, indexes, constraints and row counts: everything a no-op rerun must leave untouched. */
export async function snapshotDatabase(conn, database) {
  const tables = (await q(conn, "SELECT TABLE_NAME t FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME", [database])).map(r => r.t);
  const journal = tables.includes("__drizzle_migrations")
    ? (await q(conn, "SELECT id, hash, created_at FROM `__drizzle_migrations` ORDER BY id")).map(r => ({ id: Number(r.id), hash: r.hash, created_at: Number(r.created_at) }))
    : [];
  const columns = (await q(conn, "SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION", [database]))
    .map(r => `${r.TABLE_NAME}.${r.COLUMN_NAME} ${r.COLUMN_TYPE} null=${r.IS_NULLABLE} default=${r.COLUMN_DEFAULT ?? "∅"} ${r.EXTRA}`.trim());
  const indexes = (await q(conn, "SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX", [database]))
    .map(r => `${r.TABLE_NAME}.${r.INDEX_NAME}#${r.SEQ_IN_INDEX}=${r.COLUMN_NAME} unique=${Number(r.NON_UNIQUE) === 0}`);
  const constraints = (await q(conn, "SELECT tc.TABLE_NAME, tc.CONSTRAINT_NAME, tc.CONSTRAINT_TYPE, k.COLUMN_NAME, k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME FROM information_schema.TABLE_CONSTRAINTS tc LEFT JOIN information_schema.KEY_COLUMN_USAGE k ON k.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND k.TABLE_NAME = tc.TABLE_NAME AND k.CONSTRAINT_NAME = tc.CONSTRAINT_NAME WHERE tc.CONSTRAINT_SCHEMA = ? ORDER BY tc.TABLE_NAME, tc.CONSTRAINT_NAME, k.ORDINAL_POSITION", [database]))
    .map(r => `${r.TABLE_NAME}.${r.CONSTRAINT_NAME} ${r.CONSTRAINT_TYPE} ${r.COLUMN_NAME ?? ""}${r.REFERENCED_TABLE_NAME ? ` -> ${r.REFERENCED_TABLE_NAME}.${r.REFERENCED_COLUMN_NAME}` : ""}`.trim());
  const counts = {};
  for (const t of tables.filter(n => n !== "__drizzle_migrations")) counts[t] = Number((await q(conn, `SELECT COUNT(*) n FROM \`${t}\``))[0].n);
  const [{ v: engine }] = await q(conn, "SELECT VERSION() v");
  return { engine, database, tables, journal, columns, indexes, constraints, counts };
}

/**
 * Rows whose createdAt/updatedAt is later than the recovery point would not be covered by that backup. Covers TIMESTAMP
 * and DATETIME columns; DATETIME values are compared as UTC (the app writes them from UTC processes: Render, CI).
 */
export async function rowsNewerThan(conn, database, epochMs) {
  await conn.query("SET time_zone = '+00:00'");
  const cols = await q(conn, "SELECT TABLE_NAME t, COLUMN_NAME c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND DATA_TYPE IN ('timestamp','datetime') AND COLUMN_NAME IN ('createdAt','updatedAt') ORDER BY TABLE_NAME, COLUMN_NAME", [database]);
  const newer = {};
  for (const { t, c } of cols) {
    const n = Number((await q(conn, `SELECT COUNT(*) n FROM \`${t}\` WHERE \`${c}\` > FROM_UNIXTIME(?)`, [epochMs / 1000]))[0].n);
    if (n) newer[`${t}.${c}`] = n;
  }
  return newer;
}

/** pre -> post: migrations are additive, so no table, column or row may disappear. */
export function checkPreservation(pre, post) {
  const problems = [];
  for (const t of pre.tables) if (!post.tables.includes(t)) problems.push(`table ${t} disappeared`);
  const postCols = new Set(post.columns.map(c => c.split(" ")[0]));
  for (const c of pre.columns.map(x => x.split(" ")[0])) if (!postCols.has(c)) problems.push(`column ${c} disappeared`);
  for (const [t, n] of Object.entries(pre.counts)) if ((post.counts[t] ?? -1) < n) problems.push(`table ${t} lost rows: ${n} -> ${post.counts[t] ?? "missing"}`);
  return problems;
}

/** post -> rerun: a no-op must leave journal, schema and row counts exactly as they were. */
export function compareSnapshots(before, after) {
  const problems = [];
  for (const key of ["journal", "tables", "columns", "indexes", "constraints", "counts"]) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) problems.push(`${key} changed during the claimed no-op rerun`);
  }
  return problems;
}

async function connect(urlText) {
  const url = new URL(urlText);
  const ca = process.env.DATABASE_CA_CERT_B64;
  return mysql.createConnection({
    host: url.hostname, port: url.port ? Number(url.port) : 3306, user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.replace(/^\//, "")),
    ...(ca ? { ssl: { ca: Buffer.from(ca, "base64").toString("utf8"), rejectUnauthorized: true, minVersion: "TLSv1.2" } } : {}),
  });
}

/** One guard step. Returns { problems, report }; writes preview-migration-<mode>.json under reportDir. */
export async function runGuard(mode, { databaseUrl, expectedDatabase = "sakthiai_preview", recoveryPoint, role, root = process.cwd(), reportDir = "reports/staging", now = new Date() }) {
  const problems = [];
  const write = report => { mkdirSync(reportDir, { recursive: true }); writeFileSync(path.join(reportDir, `preview-migration-${mode}.json`), `${JSON.stringify(report, null, 2)}\n`); return { problems, report }; };
  if (!["attest", "pre", "post", "rerun", "grants"].includes(mode)) { problems.push(`unknown mode ${mode}`); return { problems, report: { mode, problems } }; }
  const recovery = mode === "attest" || mode === "pre" ? parseRecoveryPoint(recoveryPoint, now) : null;
  if (recovery) problems.push(...recovery.problems);
  const recoveryEvidence = recovery?.ok ? { class: RECOVERY_EVIDENCE_CLASS, attestedRecoveryPoint: recovery.iso, providerVerified: false } : undefined;
  if (mode === "attest") return write({ mode, recoveryEvidence, problems });

  const database = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ""));
  if (database !== expectedDatabase) { problems.push(`unexpected database ${database || "<none>"}; expected ${expectedDatabase}`); return write({ mode, problems }); }
  if (mode === "grants") {
    const conn = await connect(databaseUrl);
    try {
      const [[{ u }]] = await conn.query("SELECT CURRENT_USER() AS u");
      const lines = (await q(conn, "SHOW GRANTS")).map(r => Object.values(r)[0]);
      const principal = String(u).split("@")[0];
      const check = checkPrincipalGrants(lines, role, database);
      problems.push(...check.problems);
      if (["root", "avnadmin"].includes(principal.toLowerCase())) problems.push(`administrative principal ${principal} is not allowed`);
      return write({ mode, generatedAt: now.toISOString(), role, principal, grants: lines, privileges: check.privileges, problems });
    } finally { await conn.end(); }
  }
  const expected = expectedJournal(root);
  const conn = await connect(databaseUrl);
  try {
    const snap = await snapshotDatabase(conn, database);
    const report = { mode, generatedAt: now.toISOString(), recoveryEvidence, snapshot: snap, applied: snap.journal.length, journalEntries: expected.length, pendingTags: expected.slice(snap.journal.length).map(e => e.tag) };
    const journalProblems = checkJournal(snap.journal, expected, { complete: mode !== "pre" });
    problems.push(...journalProblems);
    // Classification needs a trustworthy journal prefix; with a broken journal the journal problems already fail the step.
    if (!journalProblems.length) {
      try {
        report.classification = classifySchema(snap, root);
        problems.push(...report.classification.problems);
      } catch (error) {
        problems.push(`schema classification failed (fail closed): ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (mode === "pre") {
      // reported, not failed: their rows are covered only by the owner's attestation that the backup postdates all writes
      report.recoveryUncoveredTables = recoveryUncoveredTables(snap);
      if (recovery?.ok) {
        report.rowsNewerThanRecoveryPoint = await rowsNewerThan(conn, database, recovery.epochMs);
        for (const [col, n] of Object.entries(report.rowsNewerThanRecoveryPoint)) problems.push(`${n} row(s) in ${col} are newer than the recovery point; take a fresh backup first`);
      }
    } else if (mode === "post") {
      problems.push(...checkPreservation(JSON.parse(readFileSync(path.join(reportDir, "preview-migration-pre.json"), "utf8")).snapshot, snap));
    } else {
      problems.push(...compareSnapshots(JSON.parse(readFileSync(path.join(reportDir, "preview-migration-post.json"), "utf8")).snapshot, snap));
    }
    report.problems = problems;
    return write(report);
  } finally {
    await conn.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const mode = process.argv[2];
  if (!["attest", "pre", "post", "rerun", "grants"].includes(mode)) { console.error("usage: preview-migration-guard.mjs attest|pre|post|rerun|grants"); process.exit(2); }
  const { problems, report } = await runGuard(mode, {
    databaseUrl: process.env.DATABASE_URL ?? "", expectedDatabase: process.env.DATABASE_EXPECTED_NAME ?? "sakthiai_preview", recoveryPoint: process.env.RECOVERY_POINT,
    role: process.env.PREVIEW_DB_ROLE,
  });
  const detail = report.snapshot ? ` engine=${report.snapshot.engine} applied=${report.applied}/${report.journalEntries} pending=${report.pendingTags.join(",") || "none"}` : "";
  const evidence = report.recoveryEvidence ? ` recovery=${report.recoveryEvidence.class}:${report.recoveryEvidence.attestedRecoveryPoint}` : "";
  const principal = mode === "grants" && report.principal ? ` role=${report.role} principal=${report.principal} privileges=${report.privileges.join("+") || "none"}` : "";
  console.log(`PREVIEW_MIGRATION_${mode.toUpperCase()} ${problems.length ? "FAIL" : "PASS"}${detail}${evidence}${principal}`);
  if (problems.length) { console.error(problems.join("\n")); process.exitCode = 1; }
}
