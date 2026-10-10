// Real MySQL 8: /readyz schema readiness against a database stuck at the pre-0005 baseline vs. a fully migrated one.
import { describe, expect, it } from "vitest";
import { createTestDatabase, migrationStatements, skipMysqlSuite } from "../testing/mysqlTestDb";
import { probeSchemaReadiness } from "./readiness";

describe.skipIf(skipMysqlSuite())("schema readiness on real SQL", { timeout: 30_000 }, () => {
  const readColumns = (db: Awaited<ReturnType<typeof createTestDatabase>>) => async () =>
    (await db.pool.promise().query("SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()"))[0] as Array<{ t: string; c: string }>;

  it("a reachable database at baseline 0004 is NOT ready: the tables of migrations 0005-0010 are reported missing", async () => {
    const db = await createTestDatabase({ migrate: false });
    try {
      const all = migrationStatements();
      for (const m of all.slice(0, all.findIndex(x => x.tag === "0004_creator_spend_control") + 1)) for (const s of m.statements) await db.pool.promise().query(s);
      const state = await probeSchemaReadiness(readColumns(db));
      expect(state.status).toBe("behind");
      expect(state.missingTables).toEqual(expect.arrayContaining(["providerWorkspacePolicies", "oauthLoginTransactions", "durableTasks", "mcpConnectors", "fileUploadSessions"]));
      expect(state.missingColumns).toBeGreaterThan(0); // documentChunks.searchText (0006) on an existing table
    } finally { await db.close(); }
  });

  it("a fully migrated database is current", async () => {
    const db = await createTestDatabase();
    try {
      expect(await probeSchemaReadiness(readColumns(db))).toMatchObject({ status: "current", missingTables: [], missingColumns: 0 });
    } finally { await db.close(); }
  });
});
