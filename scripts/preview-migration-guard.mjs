#!/usr/bin/env node
// Read-only guard around `pnpm db:push` for the preview database (used by preview-db-setup.yml).
//   pre:  the applied __drizzle_migrations rows must be an exact, in-order prefix of drizzle/meta/_journal.json;
//         records per-table row counts to reports/staging/preview-migration-pre.json.
//   post: every journal entry must be applied, in order, and no table may have lost rows since `pre`.
// Never writes to the database. TLS is verified whenever DATABASE_CA_CERT_B64 is set (the workflow requires it).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import mysql from "mysql2/promise";

const mode = process.argv[2];
if (mode !== "pre" && mode !== "post") { console.error("usage: preview-migration-guard.mjs pre|post"); process.exit(2); }
const url = new URL(process.env.DATABASE_URL ?? "");
const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
if (database !== (process.env.DATABASE_EXPECTED_NAME ?? "sakthiai_preview")) { console.error(`GUARD_FAIL: unexpected database ${database || "<none>"}`); process.exit(1); }
const ca = process.env.DATABASE_CA_CERT_B64;
const conn = await mysql.createConnection({
  host: url.hostname, port: url.port ? Number(url.port) : 3306, user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database,
  ...(ca ? { ssl: { ca: Buffer.from(ca, "base64").toString("utf8"), rejectUnauthorized: true, minVersion: "TLSv1.2" } } : {}),
});
try {
  const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")).entries;
  const [tables] = await conn.query("SELECT TABLE_NAME t FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME", [database]);
  const names = tables.map(r => r.t);
  const applied = names.includes("__drizzle_migrations")
    ? (await conn.query("SELECT created_at FROM `__drizzle_migrations` ORDER BY id"))[0].map(r => Number(r.created_at))
    : [];
  const prefixOk = applied.length <= journal.length && applied.every((when, i) => when === journal[i].when);
  const counts = {};
  for (const t of names.filter(n => n !== "__drizzle_migrations")) counts[t] = Number((await conn.query(`SELECT COUNT(*) n FROM \`${t}\``))[0][0].n);
  const [[version]] = await conn.query("SELECT VERSION() v");
  const summary = {
    mode, engine: version.v, database, applied: applied.length, journal: journal.length,
    appliedTags: journal.slice(0, applied.length).map(e => e.tag), pendingTags: journal.slice(applied.length).map(e => e.tag), counts,
  };
  mkdirSync("reports/staging", { recursive: true });
  writeFileSync(`reports/staging/preview-migration-${mode}.json`, `${JSON.stringify(summary, null, 2)}\n`);
  const problems = [];
  if (!prefixOk) problems.push("applied migrations are not an in-order prefix of the journal; reconcile manually before migrating");
  if (mode === "post") {
    if (applied.length !== journal.length) problems.push(`expected ${journal.length} applied migrations, found ${applied.length}`);
    const pre = JSON.parse(readFileSync("reports/staging/preview-migration-pre.json", "utf8")).counts;
    for (const [t, n] of Object.entries(pre)) if ((counts[t] ?? -1) < n) problems.push(`table ${t} lost rows: ${n} -> ${counts[t] ?? "missing"}`);
  }
  console.log(`PREVIEW_MIGRATION_${mode.toUpperCase()} ${problems.length ? "FAIL" : "PASS"} engine=${version.v} applied=${applied.length}/${journal.length} pending=${summary.pendingTags.join(",") || "none"}`);
  if (problems.length) { console.error(problems.join("\n")); process.exitCode = 1; }
} finally {
  await conn.end();
}
