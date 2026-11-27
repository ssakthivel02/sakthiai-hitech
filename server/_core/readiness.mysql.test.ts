// Real MySQL 8: /readyz schema readiness against a database stuck at the pre-0005 baseline vs. a fully migrated one.
import { describe, expect, it } from "vitest";
import { createTestDatabase, migrationStatements, skipMysqlSuite } from "../testing/mysqlTestDb";
import { creatorProviderJobUniqueIndexPresent, missingCriticalCreatorUniqueIndexes, probeSchemaReadiness } from "./readiness";

describe("Creator provider-job unique index is a readiness prerequisite", () => {
  const valid = [
    { t: "creatorProviderJobs", i: "creatorProviderJobs_workspace_job_uq", c: "workspaceId", nonUnique: 0, seq: 1 },
    { t: "creatorProviderJobs", i: "creatorProviderJobs_workspace_job_uq", c: "providerJobId", nonUnique: 0, seq: 2 },
  ];

  it("accepts only the exact composite UNIQUE index", () => {
    expect(creatorProviderJobUniqueIndexPresent(valid)).toBe(true);
    expect(creatorProviderJobUniqueIndexPresent([...valid].reverse())).toBe(true);
  });
  it("rejects missing or incomplete index metadata", () => {
    expect(creatorProviderJobUniqueIndexPresent([])).toBe(false);
    expect(creatorProviderJobUniqueIndexPresent(valid.slice(0, 1))).toBe(false);
  });
  it("rejects a non-unique index, reversed key order or an extra key", () => {
    expect(creatorProviderJobUniqueIndexPresent(valid.map(row => ({ ...row, nonUnique: 1 })))).toBe(false);
    expect(creatorProviderJobUniqueIndexPresent(valid.map(row => ({ ...row, c: row.c === "workspaceId" ? "providerJobId" : "workspaceId" })))).toBe(false);
    expect(creatorProviderJobUniqueIndexPresent([...valid, { ...valid[1], c: "id", seq: 3 }])).toBe(false);
  });

  it("requires generation idempotency and avatar callback unique constraints in addition to provider jobs", () => {
    const additional = [
      { t: "creatorGenerations", i: "creatorGenerations_workspaceId_idempotencyKey_unique", c: "workspaceId", nonUnique: 0, seq: 1 },
      { t: "creatorGenerations", i: "creatorGenerations_workspaceId_idempotencyKey_unique", c: "idempotencyKey", nonUnique: 0, seq: 2 },
      { t: "creatorAvatarDispatchAdmissions", i: "creatorAvatarDispatchAdmissions_workspace_callback_uq", c: "workspaceId", nonUnique: 0, seq: 1 },
      { t: "creatorAvatarDispatchAdmissions", i: "creatorAvatarDispatchAdmissions_workspace_callback_uq", c: "callbackId", nonUnique: 0, seq: 2 },
      ...["workspaceId", "creatorProjectId", "timelineId", "mode", "fingerprint"].map((column, i) => ({ t: "creatorRenderClaims", i: "creatorRenderClaims_scope_fingerprint_uq", c: column, nonUnique: 0, seq: i + 1 })),
    ];
    const all = [...valid, ...additional];
    expect(missingCriticalCreatorUniqueIndexes(all)).toEqual([]);
    expect(missingCriticalCreatorUniqueIndexes([...valid, ...additional.filter(row => row.t !== "creatorGenerations")]))
      .toEqual(["creatorGenerations_workspaceId_idempotencyKey_unique"]);
    expect(missingCriticalCreatorUniqueIndexes([...valid, ...additional.filter(row => row.t !== "creatorAvatarDispatchAdmissions")]))
      .toEqual(["creatorAvatarDispatchAdmissions_workspace_callback_uq"]);
    expect(missingCriticalCreatorUniqueIndexes(all.map(row => row.t === "creatorGenerations" ? { ...row, nonUnique: 1 } : row)))
      .toEqual(["creatorGenerations_workspaceId_idempotencyKey_unique"]);
    expect(missingCriticalCreatorUniqueIndexes(all.map(row => row.t === "creatorAvatarDispatchAdmissions" ? { ...row, c: row.c === "workspaceId" ? "callbackId" : "workspaceId" } : row)))
      .toEqual(["creatorAvatarDispatchAdmissions_workspace_callback_uq"]);
    expect(missingCriticalCreatorUniqueIndexes(all.filter(row => row.t !== "creatorRenderClaims")))
      .toEqual(["creatorRenderClaims_scope_fingerprint_uq"]);
    expect(missingCriticalCreatorUniqueIndexes(all.map(row => row.t === "creatorRenderClaims" && row.c === "fingerprint" ? { ...row, nonUnique: 1 } : row)))
      .toEqual(["creatorRenderClaims_scope_fingerprint_uq"]);
    expect(missingCriticalCreatorUniqueIndexes(all.map(row => row.t === "creatorRenderClaims" && row.c === "timelineId" ? { ...row, seq: 99 } : row)))
      .toEqual(["creatorRenderClaims_scope_fingerprint_uq"]);
  });
});

describe.skipIf(skipMysqlSuite())("schema readiness on real SQL", { timeout: 30_000 }, () => {
  const readColumns = (db: Awaited<ReturnType<typeof createTestDatabase>>) => async () =>
    (await db.pool.promise().query("SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()"))[0] as Array<{ t: string; c: string }>;
  const readIndexes = (db: Awaited<ReturnType<typeof createTestDatabase>>) => async () =>
    (await db.pool.promise().query(
      "SELECT TABLE_NAME AS t, INDEX_NAME AS i, COLUMN_NAME AS c, NON_UNIQUE AS nonUnique, SEQ_IN_INDEX AS seq FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND ((TABLE_NAME = 'creatorProviderJobs' AND INDEX_NAME = 'creatorProviderJobs_workspace_job_uq') OR (TABLE_NAME = 'creatorGenerations' AND INDEX_NAME = 'creatorGenerations_workspaceId_idempotencyKey_unique') OR (TABLE_NAME = 'creatorAvatarDispatchAdmissions' AND INDEX_NAME = 'creatorAvatarDispatchAdmissions_workspace_callback_uq') OR (TABLE_NAME = 'creatorRenderClaims' AND INDEX_NAME = 'creatorRenderClaims_scope_fingerprint_uq')) ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX",
    ))[0] as Array<{ t: string; i: string; c: string | null; nonUnique: number; seq: number }>;

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

  const migratedThrough = async (tag: string) => {
    const db = await createTestDatabase({ migrate: false });
    const all = migrationStatements();
    for (const m of all.slice(0, all.findIndex(x => x.tag === tag) + 1)) for (const s of m.statements) await db.pool.promise().query(s);
    return db;
  };

  it("a database at 0010 (before the Creator spend ledger) is NOT ready: 0011's, 0013's and 0014's tables are reported missing", async () => {
    const db = await migratedThrough("0010_resumable_ingestion");
    try {
      const state = await probeSchemaReadiness(readColumns(db));
      expect(state).toMatchObject({ status: "behind", missingTables: ["artifactFileReferences", "artifacts", "creatorArtifactLeases", "creatorAvatarDispatchAdmissions", "creatorConsents", "creatorMuruganBibleApprovals", "creatorMuruganShotLocks", "creatorMuruganShotPlans", "creatorRemediationLineage", "creatorRenderClaims", "creatorSpendHolds", "creatorSpendWindows", "rateLimitWindows"] });
    } finally { await db.close(); }
  });

  it("a database at 0011 is NOT ready: exactly the two 0012 audit columns (and 0013's and 0014's tables) are missing", async () => {
    const db = await migratedThrough("0011_creator_spend_ledger");
    try {
      expect(await probeSchemaReadiness(readColumns(db))).toMatchObject({ status: "behind", missingTables: ["artifactFileReferences", "artifacts", "creatorArtifactLeases", "creatorAvatarDispatchAdmissions", "creatorConsents", "creatorMuruganBibleApprovals", "creatorMuruganShotLocks", "creatorMuruganShotPlans", "creatorRemediationLineage", "creatorRenderClaims", "rateLimitWindows"], missingColumns: 2 });
    } finally { await db.close(); }
  });

  it("a database at 0012 is NOT ready: only 0013's rate-limit table and 0014's artifacts table are missing", async () => {
    const db = await migratedThrough("0012_creator_spend_settlement_audit");
    try {
      expect(await probeSchemaReadiness(readColumns(db))).toMatchObject({ status: "behind", missingTables: ["artifactFileReferences", "artifacts", "creatorArtifactLeases", "creatorAvatarDispatchAdmissions", "creatorConsents", "creatorMuruganBibleApprovals", "creatorMuruganShotLocks", "creatorMuruganShotPlans", "creatorRemediationLineage", "creatorRenderClaims", "rateLimitWindows"], missingColumns: 0 });
    } finally { await db.close(); }
  });

  it("a database at 0013 (rate-limit table, before workspace artifacts) is NOT ready: 0014's artifacts and 0015's link tables are missing", async () => {
    const db = await migratedThrough("0013_rate_limit_windows");
    try {
      expect(await probeSchemaReadiness(readColumns(db))).toMatchObject({ status: "behind", missingTables: ["artifactFileReferences", "artifacts", "creatorArtifactLeases", "creatorAvatarDispatchAdmissions", "creatorConsents", "creatorMuruganBibleApprovals", "creatorMuruganShotLocks", "creatorMuruganShotPlans", "creatorRemediationLineage", "creatorRenderClaims"], missingColumns: 0 });
    } finally { await db.close(); }
  });

  it("a database at 0014 (artifacts, before file references) is NOT ready: only 0015's link table is missing", async () => {
    const db = await migratedThrough("0014_workspace_artifacts");
    try {
      expect(await probeSchemaReadiness(readColumns(db))).toMatchObject({ status: "behind", missingTables: ["artifactFileReferences", "creatorArtifactLeases", "creatorAvatarDispatchAdmissions", "creatorConsents", "creatorMuruganBibleApprovals", "creatorMuruganShotLocks", "creatorMuruganShotPlans", "creatorRemediationLineage", "creatorRenderClaims"], missingColumns: 0 });
    } finally { await db.close(); }
  });

  it("a database at 0015 (before speech/avatar consent) is NOT ready: only 0016's consent table is missing", async () => {
    const db = await migratedThrough("0015_artifact_file_references");
    try {
      expect(await probeSchemaReadiness(readColumns(db))).toMatchObject({ status: "behind", missingTables: ["creatorArtifactLeases", "creatorAvatarDispatchAdmissions", "creatorConsents", "creatorMuruganBibleApprovals", "creatorMuruganShotLocks", "creatorMuruganShotPlans", "creatorRemediationLineage", "creatorRenderClaims"], missingColumns: 0 });
    } finally { await db.close(); }
  });

  it("a fully migrated database is current", async () => {
    const db = await createTestDatabase();
    try {
      expect(await probeSchemaReadiness(readColumns(db))).toMatchObject({ status: "current", missingTables: [], missingColumns: 0 });
    } finally { await db.close(); }
  });
  it("a fully migrated DB with the 0021 UNIQUE index dropped is NOT ready even though all columns remain", async () => {
    const db = await createTestDatabase();
    try {
      expect(await probeSchemaReadiness(readColumns(db), readIndexes(db))).toMatchObject({ status: "current", missingIndexes: 0 });
      await db.pool.promise().query("ALTER TABLE `creatorProviderJobs` DROP INDEX `creatorProviderJobs_workspace_job_uq`");
      // This was the old false positive: column-only inspection still sees the entire expected schema.
      expect((await probeSchemaReadiness(readColumns(db))).status).toBe("current");
      const after = await probeSchemaReadiness(readColumns(db), readIndexes(db));
      expect(after).toMatchObject({ status: "behind", missingTables: [], missingColumns: 0, missingIndexes: 1 });
    } finally {
      await db.close();
    }
  });

  it.each([
    ["generation idempotency", "creatorGenerations", "creatorGenerations_workspaceId_idempotencyKey_unique"],
    ["avatar callback admission", "creatorAvatarDispatchAdmissions", "creatorAvatarDispatchAdmissions_workspace_callback_uq"],
    ["fenced render-claim fingerprint", "creatorRenderClaims", "creatorRenderClaims_scope_fingerprint_uq"],
  ] as const)("refuses %s when its UNIQUE constraint is dropped in an isolated MySQL test DB", async (_label, table, index) => {
    const db = await createTestDatabase();
    try {
      expect(await probeSchemaReadiness(readColumns(db), readIndexes(db))).toMatchObject({ status: "current", missingIndexes: 0 });
      // Deliberately alter ONLY the disposable test schema. Column-only probing would still falsely pass.
      await db.pool.promise().query(`ALTER TABLE \`${table}\` DROP INDEX \`${index}\``);
      expect((await probeSchemaReadiness(readColumns(db))).status).toBe("current");
      expect(await probeSchemaReadiness(readColumns(db), readIndexes(db)))
        .toMatchObject({ status: "behind", missingTables: [], missingColumns: 0, missingIndexes: 1 });
    } finally {
      await db.close();
    }
  });
});
