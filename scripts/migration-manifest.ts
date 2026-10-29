// Runtime migration manifest for the pending 0005-0010 set + searchText backfill, verified ONLY against a throwaway local server.
// Uses drizzle's real migrator (the same mechanism as `drizzle-kit migrate`, journal table __drizzle_migrations).
// Usage: TEST_DATABASE_URL=mysql://root:pw@127.0.0.1:3306 pnpm tsx scripts/migration-manifest.ts
// Never touches a managed/live host (parseTarget refuses them). Writes reports/staging/runtime-migration-manifest.json.
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import mysql from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import { createScratchDatabase, dropScratchDatabase, parseTarget, withDatabase } from "../server/recovery/rehearsal";
import { backfillSearchText, searchWorkspaceChunks } from "../server/retrievalStore";


const BASELINE = "0004_creator_spend_control";
const base = process.env.TEST_DATABASE_URL;
if (!base) { console.error("MANIFEST_FAIL: TEST_DATABASE_URL (a throwaway LOCAL server) is required"); process.exit(2); }
parseTarget(base); // refuses managed hosts

type Entry = { idx: number; version: string; when: number; tag: string; breakpoints: boolean };
const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")) as { entries: Entry[] };
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const baselineIdx = journal.entries.find(e => e.tag === BASELINE)!.idx;
const pending = journal.entries.filter(e => e.idx > baselineIdx);

const problems: string[] = [];
for (let i = 1; i < journal.entries.length; i++) if (journal.entries[i].when <= journal.entries[i - 1].when) problems.push(`journal 'when' not strictly increasing at ${journal.entries[i].tag}`);

const files = pending.map(e => {
  const text = readFileSync(`drizzle/${e.tag}.sql`, "utf8");
  const statements = text.split("--> statement-breakpoint").map(p => p.trim()).filter(Boolean);
  const kinds = (re: RegExp) => [...text.matchAll(re)].map(m => m[1]);
  return {
    idx: e.idx, tag: e.tag, when: e.when, sha256: sha(text), statements: statements.length,
    createsTables: kinds(/CREATE TABLE `([^`]+)`/g), createsIndexes: kinds(/CREATE (?:UNIQUE )?INDEX `([^`]+)`/g), alters: kinds(/ALTER TABLE `([^`]+)`/g),
    destructive: statements.filter(s => /^(DROP|TRUNCATE|DELETE)\b/i.test(s)).length,
  };
});
for (const f of files) if (f.destructive) problems.push(`${f.tag} contains ${f.destructive} destructive statement(s)`);

const truncatedFolder = (root: string, upToIdx: number) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mig-"));
  mkdirSync(path.join(dir, "meta"));
  const entries = journal.entries.filter(e => e.idx <= upToIdx);
  for (const e of entries) cpSync(`${root}/${e.tag}.sql`, path.join(dir, `${e.tag}.sql`));
  writeFileSync(path.join(dir, "meta/_journal.json"), JSON.stringify({ ...JSON.parse(readFileSync(`${root}/meta/_journal.json`, "utf8")), entries }));
  return dir;
};

const open = async (url: string) => { const t = parseTarget(url); const pool = mysql.createPool({ host: t.host, port: t.port, user: t.user, password: t.password, database: new URL(url).pathname.slice(1), connectionLimit: 2 }); return { pool, db: drizzle(pool) }; };
const columns = async (pool: mysql.Pool, db: string) => { const [r] = await pool.query("SELECT TABLE_NAME t, COLUMN_NAME c, COLUMN_TYPE ty FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION", [db]); return (r as Array<{ t: string; c: string; ty: string }>).filter(x => x.t !== "__drizzle_migrations").map(x => `${x.t}.${x.c}:${x.ty}`); };
const appliedCount = async (pool: mysql.Pool) => Number((((await pool.query("SELECT COUNT(*) n FROM `__drizzle_migrations`")) as any)[0][0]).n);

const steps: Array<{ step: string; ok: boolean; detail?: unknown }> = [];
const record = (step: string, ok: boolean, detail?: unknown) => { steps.push({ step, ok, detail }); if (!ok) problems.push(`${step} failed`); };

const scratch = await createScratchDatabase(base, "sakthi_rr"); const ref = await createScratchDatabase(base, "sakthi_rr");
let engine = "unknown"; let backfilled = 0; let secondBackfill = -1;
try {
  const { pool, db } = await open(scratch.url); const r = await open(ref.url);
  engine = String((((await pool.query("SELECT VERSION() v")) as any)[0][0]).v);
  // 1) baseline: exactly what the live preview DB is expected to look like (0000-0004), applied with the real migrator
  const baseDir = truncatedFolder("drizzle", baselineIdx);
  await migrate(db, { migrationsFolder: baseDir });
  record("baseline-0000-0004-applied", (await appliedCount(pool)) === baselineIdx + 1, { applied: await appliedCount(pool) });
  // 2) legacy data that the pending migrations and the backfill must preserve
  await pool.query("INSERT INTO users (openId, name) VALUES ('legacy','L')");
  await pool.query("INSERT INTO workspaces (ownerUserId, name, slug) VALUES (1,'Legacy','legacy')");
  await pool.query("INSERT INTO documents (workspaceId, filename, mimeType, extractedText, contentHash, pageCount) VALUES (1,'old.txt','text/plain','x',?,1)", ["9".repeat(64)]);
  await pool.query("INSERT INTO documentChunks (documentId, workspaceId, chunkIndex, content) VALUES (1,1,0,'முருகன் கோவில் பழநியில் உள்ளது'),(1,1,1,'palani murugan kovil kaalai thirakkum')");
  // 3) apply the pending set (0005-0010) with the full journal: must apply exactly these, in order
  await migrate(db, { migrationsFolder: "drizzle" });
  const total = journal.entries.length;
  record("pending-0005-0010-applied-in-order", (await appliedCount(pool)) === total, { applied: await appliedCount(pool), expected: total, tags: pending.map(p => p.tag) });
  // 4) idempotence: running the migrator again changes nothing
  const before = await columns(pool, scratch.name); await migrate(db, { migrationsFolder: "drizzle" });
  record("migrator-rerun-is-noop", (await appliedCount(pool)) === total && JSON.stringify(before) === JSON.stringify(await columns(pool, scratch.name)));
  // 5) data preserved, no drift against a freshly migrated database
  const [[docs]] = (await pool.query("SELECT COUNT(*) n FROM documents")) as any; const [[chunks]] = (await pool.query("SELECT COUNT(*) n FROM documentChunks WHERE searchText IS NULL")) as any;
  record("legacy-data-preserved", Number(docs.n) === 1 && Number(chunks.n) === 2, { documents: Number(docs.n), nullSearchTextChunks: Number(chunks.n) });
  await migrate(r.db, { migrationsFolder: "drizzle" });
  const refCols = (await columns(r.pool, ref.name)); const upCols = await columns(pool, scratch.name);
  record("schema-equals-fresh-migration", JSON.stringify(refCols) === JSON.stringify(upCols), { columns: upCols.length });
  // 6) backfill: complete, idempotent, searchable cross-script afterwards
  backfilled = await backfillSearchText(db as any); secondBackfill = await backfillSearchText(db as any);
  record("backfill-complete-and-idempotent", backfilled === 2 && secondBackfill === 0, { first: backfilled, second: secondBackfill });
  const found = (await searchWorkspaceChunks(db as any, 1, "kovil kaalai", null)).map(x => x.filename);
  record("post-backfill-search-works", found.length >= 1, { hits: found.length });
  await pool.end(); await r.pool.end();
} catch (error) {
  record("unexpected-error", false, (error as Error).message.slice(0, 300));
} finally {
  await dropScratchDatabase(base, scratch.name); await dropScratchDatabase(base, ref.name);
}

const manifest = {
  schema: "sakthiai.runtime-migration-manifest/v1",
  evidenceClass: "LOCAL_REHEARSAL",
  generatedAt: new Date().toISOString(),
  engine,
  mechanism: "drizzle-orm migrator (journal table __drizzle_migrations), forward-only; rollback = restore the pre-migration Aiven recovery point",
  baselineAssumption: `${BASELINE} (verify on the live DB before applying: SELECT COUNT(*) FROM __drizzle_migrations must equal ${baselineIdx + 1})`,
  pending: files,
  postMigration: { command: "pnpm db:backfill-search-text", note: "fills NULL searchText and upgrades pre-0019 rows (adds the ~tl~ transliteration key block); idempotent; rerun returns 0" },
  verification: steps,
  liveDatabaseTouched: false, managedDatabaseTouched: false, aivenTouched: false, renderTouched: false,
  runtimeVerified: false,
  passed: problems.length === 0,
  problems,
};
mkdirSync("reports/staging", { recursive: true });
writeFileSync("reports/staging/runtime-migration-manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`MIGRATION_MANIFEST ${manifest.passed ? "PASS" : "FAIL"} engine=${engine} pending=${files.length} steps=${steps.filter(s => s.ok).length}/${steps.length}`);
if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
