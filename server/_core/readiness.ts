import { is, sql } from "drizzle-orm";
import { MySqlTable, getTableConfig } from "drizzle-orm/mysql-core";
import * as schema from "../../drizzle/schema";
import { getDb } from "../db";

type LiveDatabaseProbe = () => Promise<unknown>;

export async function probeDatabaseReadiness(liveProbe?: LiveDatabaseProbe): Promise<boolean> {
  try {
    if (liveProbe) {
      await liveProbe();
      return true;
    }

    const db = await getDb();
    if (!db) return false;

    await db.execute(sql`SELECT 1`);
    return true;
  } catch {
    return false;
  }
}

export type SchemaReadiness = {
  status: "current" | "behind" | "unknown";
  expectedTables: number;
  missingTables: string[];
  missingColumns: number;
  /** Present only when the protected runtime also inspected the Creator provider-job unique index. */
  missingIndexes?: number;
};
type ColumnRow = { t: string; c: string };
type CriticalIndexRow = { t: string; i: string; c: string | null; nonUnique: number | string; seq: number | string };
const CREATOR_JOB_UNIQUE_INDEX = "creatorProviderJobs_workspace_job_uq";

/** Uniqueness is a runtime safety requirement for paid generation and avatar admission.
 * A schema with all columns can still be missing these additive migration constraints.
 * This is an explicit bounded allowlist, not an assertion that every SQL index is checked.
 */
const CRITICAL_CREATOR_UNIQUE_INDEXES = [
  { table: "creatorProviderJobs", name: CREATOR_JOB_UNIQUE_INDEX, columns: ["workspaceId", "providerJobId"] },
  { table: "creatorGenerations", name: "creatorGenerations_workspaceId_idempotencyKey_unique", columns: ["workspaceId", "idempotencyKey"] },
  { table: "creatorAvatarDispatchAdmissions", name: "creatorAvatarDispatchAdmissions_workspace_callback_uq", columns: ["workspaceId", "callbackId"] },
] as const;

function exactCompositeUniqueIndexPresent(rows: CriticalIndexRow[], spec: (typeof CRITICAL_CREATOR_UNIQUE_INDEXES)[number]): boolean {
  const relevant = rows
    .filter(row => row.t?.toLowerCase() === spec.table.toLowerCase() && row.i?.toLowerCase() === spec.name.toLowerCase())
    .sort((a, b) => Number(a.seq) - Number(b.seq));
  return relevant.length === spec.columns.length &&
    relevant.every((row, i) => Number(row.seq) === i + 1 && Number(row.nonUnique) === 0 && row.c === spec.columns[i]);
}

/** Migration 0021 adds a unique two-column provider-job identity fence. Keep the public test helper stable. */
export function creatorProviderJobUniqueIndexPresent(rows: CriticalIndexRow[]): boolean {
  return exactCompositeUniqueIndexPresent(rows, CRITICAL_CREATOR_UNIQUE_INDEXES[0]);
}

/** The actual runtime requires all three source-defined uniqueness guards. Names are never returned by /readyz. */
export function missingCriticalCreatorUniqueIndexes(rows: CriticalIndexRow[]): string[] {
  return CRITICAL_CREATOR_UNIQUE_INDEXES.filter(spec => !exactCompositeUniqueIndexPresent(rows, spec)).map(spec => spec.name);
}

/** Every table and column this build's Drizzle schema declares; the connected database must contain all of them. */
export function expectedSchema(): Map<string, string[]> {
  const tables = new Map<string, string[]>();
  for (const value of Object.values(schema)) {
    if (!is(value, MySqlTable)) continue;
    const config = getTableConfig(value);
    tables.set(config.name, config.columns.map(column => column.name));
  }
  return tables;
}

/** Additive forward-only migrations: extra objects are fine, any declared table or column that is absent means not ready. */
export function compareSchema(expected: Map<string, string[]>, present: ColumnRow[]): SchemaReadiness {
  const have = new Map<string, Set<string>>();
  for (const { t, c } of present) (have.get(t) ?? have.set(t, new Set()).get(t)!).add(c);
  const missingTables: string[] = [];
  let missingColumns = 0;
  for (const [table, columns] of expected) {
    const found = have.get(table);
    if (!found) { missingTables.push(table); continue; }
    missingColumns += columns.filter(column => !found.has(column)).length;
  }
  return { status: missingTables.length || missingColumns ? "behind" : "current", expectedTables: expected.size, missingTables: missingTables.sort(), missingColumns };
}

/**
 * A reachable database is not a ready one: the schema must match this build (e.g. migrations 0005-0010 applied).
 * Reads information_schema only; any failure is reported as "unknown", which is not ready.
 */
export async function probeSchemaReadiness(
  readColumns?: () => Promise<ColumnRow[]>,
  readIndexes?: () => Promise<CriticalIndexRow[]>,
): Promise<SchemaReadiness> {
  const expected = expectedSchema();
  try {
    let rows: ColumnRow[];
    if (readColumns) rows = await readColumns();
    else {
      const db = await getDb();
      if (!db) throw new Error("database unavailable");
      const result = await db.execute(sql`SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()`);
      rows = (Array.isArray(result) ? result[0] : result) as unknown as ColumnRow[];
    }
    const columnState = compareSchema(expected, rows);
    if (columnState.status !== "current") return columnState;
    // Partial column-only injection is retained for legacy unit tests; production uses BOTH metadata probes.
    if (readColumns && !readIndexes) return columnState;
    let indexRows: CriticalIndexRow[];
    if (readIndexes) indexRows = await readIndexes();
    else {
      const db = await getDb();
      if (!db) throw new Error("database unavailable");
      const indexResult = await db.execute(sql`
        SELECT TABLE_NAME AS t, INDEX_NAME AS i, COLUMN_NAME AS c, NON_UNIQUE AS nonUnique, SEQ_IN_INDEX AS seq
        FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE()
          AND (
            (TABLE_NAME = 'creatorProviderJobs' AND INDEX_NAME = 'creatorProviderJobs_workspace_job_uq')
            OR (TABLE_NAME = 'creatorGenerations' AND INDEX_NAME = 'creatorGenerations_workspaceId_idempotencyKey_unique')
            OR (TABLE_NAME = 'creatorAvatarDispatchAdmissions' AND INDEX_NAME = 'creatorAvatarDispatchAdmissions_workspace_callback_uq')
          )
        ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`);
      indexRows = (Array.isArray(indexResult) ? indexResult[0] : indexResult) as unknown as CriticalIndexRow[];
    }
    const missingCriticalIndexes = missingCriticalCreatorUniqueIndexes(indexRows);
    if (missingCriticalIndexes.length) {
      // Do not leak table/index identities through /readyz; only publish the count.
      return { ...columnState, status: "behind", missingIndexes: missingCriticalIndexes.length };
    }
    return { ...columnState, missingIndexes: 0 };
  } catch {
    return { status: "unknown", expectedTables: expected.size, missingTables: [], missingColumns: 0 };
  }
}

export type StorageReadiness = { state: "configured" | "missing_configuration" | "not_required"; ok: boolean };

/**
 * Object storage is a dependency of file upload / Creator media only. Chat, projects and retrieval never read or write it
 * (documents.storageKey is nullable; synthetic sources are stored without an object). So with uploads OFF a missing bucket
 * must not hold the whole service not-ready; with uploads ON it still must.
 */
export function storageReadiness(input: { uploadsEnabled: boolean; configured: boolean }): StorageReadiness {
  if (input.uploadsEnabled) return input.configured ? { state: "configured", ok: true } : { state: "missing_configuration", ok: false };
  return { state: input.configured ? "configured" : "not_required", ok: true };
}
