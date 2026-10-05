#!/usr/bin/env node
// Read-only guard around `pnpm db:push` for the non-disposable preview database (used by preview-db-setup.yml).
//   attest: RECOVERY_POINT must be a real, non-future UTC instant (YYYY-MM-DDTHH:MM[:SS[.ffffff]]Z). No database access.
//   pre:    applied __drizzle_migrations rows must be an exact in-order prefix of the journal, matching the Drizzle
//           migrator's own format (hash = sha256 of drizzle/<tag>.sql, created_at = journal `when`); no row may be newer
//           than the attested recovery point; snapshot schema + journal + row counts.
//   post:   every journal entry applied (same check); no table, column or row lost since `pre`; snapshot.
//   rerun:  after a second `db:push`, journal rows, schema and row counts must be identical to the `post` snapshot.
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

/** Rows whose TIMESTAMP createdAt/updatedAt is later than the recovery point would not be covered by that backup. */
export async function rowsNewerThan(conn, database, epochMs) {
  await conn.query("SET time_zone = '+00:00'");
  const cols = await q(conn, "SELECT TABLE_NAME t, COLUMN_NAME c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND DATA_TYPE = 'timestamp' AND COLUMN_NAME IN ('createdAt','updatedAt') ORDER BY TABLE_NAME, COLUMN_NAME", [database]);
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
export async function runGuard(mode, { databaseUrl, expectedDatabase = "sakthiai_preview", recoveryPoint, root = process.cwd(), reportDir = "reports/staging", now = new Date() }) {
  const problems = [];
  const write = report => { mkdirSync(reportDir, { recursive: true }); writeFileSync(path.join(reportDir, `preview-migration-${mode}.json`), `${JSON.stringify(report, null, 2)}\n`); return { problems, report }; };
  if (!["attest", "pre", "post", "rerun"].includes(mode)) { problems.push(`unknown mode ${mode}`); return { problems, report: { mode, problems } }; }
  const recovery = mode === "attest" || mode === "pre" ? parseRecoveryPoint(recoveryPoint, now) : null;
  if (recovery) problems.push(...recovery.problems);
  const recoveryEvidence = recovery?.ok ? { class: RECOVERY_EVIDENCE_CLASS, attestedRecoveryPoint: recovery.iso, providerVerified: false } : undefined;
  if (mode === "attest") return write({ mode, recoveryEvidence, problems });

  const database = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ""));
  if (database !== expectedDatabase) { problems.push(`unexpected database ${database || "<none>"}; expected ${expectedDatabase}`); return write({ mode, problems }); }
  const expected = expectedJournal(root);
  const conn = await connect(databaseUrl);
  try {
    const snap = await snapshotDatabase(conn, database);
    const report = { mode, generatedAt: now.toISOString(), recoveryEvidence, snapshot: snap, applied: snap.journal.length, journalEntries: expected.length, pendingTags: expected.slice(snap.journal.length).map(e => e.tag) };
    if (mode === "pre") {
      problems.push(...checkJournal(snap.journal, expected));
      if (recovery?.ok) {
        report.rowsNewerThanRecoveryPoint = await rowsNewerThan(conn, database, recovery.epochMs);
        for (const [col, n] of Object.entries(report.rowsNewerThanRecoveryPoint)) problems.push(`${n} row(s) in ${col} are newer than the recovery point; take a fresh backup first`);
      }
    } else if (mode === "post") {
      problems.push(...checkJournal(snap.journal, expected, { complete: true }));
      problems.push(...checkPreservation(JSON.parse(readFileSync(path.join(reportDir, "preview-migration-pre.json"), "utf8")).snapshot, snap));
    } else {
      problems.push(...checkJournal(snap.journal, expected, { complete: true }));
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
  if (!["attest", "pre", "post", "rerun"].includes(mode)) { console.error("usage: preview-migration-guard.mjs attest|pre|post|rerun"); process.exit(2); }
  const { problems, report } = await runGuard(mode, {
    databaseUrl: process.env.DATABASE_URL ?? "", expectedDatabase: process.env.DATABASE_EXPECTED_NAME ?? "sakthiai_preview", recoveryPoint: process.env.RECOVERY_POINT,
  });
  const detail = report.snapshot ? ` engine=${report.snapshot.engine} applied=${report.applied}/${report.journalEntries} pending=${report.pendingTags.join(",") || "none"}` : "";
  const evidence = report.recoveryEvidence ? ` recovery=${report.recoveryEvidence.class}:${report.recoveryEvidence.attestedRecoveryPoint}` : "";
  console.log(`PREVIEW_MIGRATION_${mode.toUpperCase()} ${problems.length ? "FAIL" : "PASS"}${detail}${evidence}`);
  if (problems.length) { console.error(problems.join("\n")); process.exitCode = 1; }
}
