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
};
type ColumnRow = { t: string; c: string };

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
export async function probeSchemaReadiness(readColumns?: () => Promise<ColumnRow[]>): Promise<SchemaReadiness> {
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
    return compareSchema(expected, rows);
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
