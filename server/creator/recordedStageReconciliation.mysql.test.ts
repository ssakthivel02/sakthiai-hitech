import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { createTestDatabase, skipMysqlSuite, type TestDatabase } from "../testing/mysqlTestDb";

const state = vi.hoisted(() => ({
  db: undefined as unknown,
  objects: new Map<string, { size: number; checksum: string }>(),
  probes: 0,
}));
vi.mock("../db", async importOriginal => ({
  ...(await importOriginal<typeof import("../db")>()),
  getDb: async () => state.db,
}));
vi.mock("../storage", async importOriginal => ({
  ...(await importOriginal<typeof import("../storage")>()),
  storageVerifySha256: async (key: string, size: number, checksum: string) => {
    state.probes++;
    const object = state.objects.get(key);
    if (!object) { const error = new Error("NoSuchKey"); error.name = "NoSuchKey"; throw error; }
    if (object.size !== size || object.checksum !== checksum) throw new Error("CHECKSUM_MISMATCH");
  },
}));
import { inspectCreatorRecordedStages } from "./recordedStageReconciliation";

const WORKSPACE = 6959;
const PROJECT = 7959;
const PROVIDER = "google-veo";
const CHECKSUM = "d".repeat(64);

describe.skipIf(skipMysqlSuite())("Creator DB-recorded stage reconciliation (disposable MySQL)", () => {
  let d: TestDatabase;
  const query = async (sql: string, values: unknown[] = []) => {
    const [rows] = await d.pool.promise().query<RowDataPacket[]>(sql, values);
    return rows;
  };
  const insert = async (sql: string, values: unknown[] = []) => {
    const [result] = await d.pool.promise().query<ResultSetHeader>(sql, values);
    return result.insertId;
  };
  const seed = async (jobId: string, options: { workspace?: number; active?: boolean } = {}) => {
    const workspace = options.workspace ?? WORKSPACE;
    const generationId = await insert(
      "INSERT INTO creatorGenerations (workspaceId, creatorProjectId, kind, provider, model, parametersJson, status) VALUES (?, ?, 'VIDEO', ?, 'test', '{}', 'RUNNING')",
      [workspace, PROJECT, PROVIDER],
    );
    await insert(
      "INSERT INTO creatorProviderJobs (workspaceId, creatorProjectId, generationId, provider, providerJobId, status, snapshotJson) VALUES (?, ?, ?, ?, ?, 'SUCCEEDED', '{}')",
      [workspace, PROJECT, generationId, PROVIDER, jobId],
    );
    const hash = createHash("sha256").update(PROVIDER).update("\0").update(jobId).digest("hex").slice(0, 32);
    const key = `creator/${workspace}/${PROJECT}/staged/generation-${generationId}/job-${hash}/${CHECKSUM}.mp4`;
    await insert(
      `INSERT INTO creatorArtifactLeases
       (generationId, workspaceId, creatorProjectId, providerJobId, leaseToken, leaseUntil,
        stagedStorageKey, stagedChecksumSha256, stagedByteSize, stagedMimeType)
       VALUES (?, ?, ?, ?, 'test-token', ${options.active ? "DATE_ADD(NOW(3), INTERVAL 5 MINUTE)" : "DATE_SUB(NOW(3), INTERVAL 1 SECOND)"}, ?, ?, 12, 'video/mp4')`,
      [generationId, workspace, PROJECT, jobId, key, CHECKSUM],
    );
    return { generationId, key, workspace, jobId };
  };

  beforeAll(async () => { d = await createTestDatabase(); state.db = d.db; });
  afterAll(async () => { await d?.close(); });
  beforeEach(async () => {
    await d.pool.promise().query("DELETE FROM creatorArtifactLeases");
    await d.pool.promise().query("DELETE FROM creatorAssets");
    await d.pool.promise().query("DELETE FROM creatorProviderJobs");
    await d.pool.promise().query("DELETE FROM creatorGenerations");
    state.objects.clear(); state.probes = 0;
  });

  it("reports a DB-recorded missing object without changing jobs or leases", async () => {
    const seeded = await seed("missing-object");
    const before = await query("SELECT providerJobId, stagedStorageKey FROM creatorArtifactLeases WHERE generationId = ?", [seeded.generationId]);
    const result = await inspectCreatorRecordedStages({ workspaceId: WORKSPACE });
    expect(result.findings).toEqual([{ generationId: seeded.generationId, key: seeded.key, finding: "MISSING_OBJECT" }]);
    expect(await query("SELECT providerJobId, stagedStorageKey FROM creatorArtifactLeases WHERE generationId = ?", [seeded.generationId])).toEqual(before);
    expect(await query("SELECT * FROM creatorProviderJobs WHERE generationId = ?", [seeded.generationId])).toHaveLength(1);
    expect(state.probes).toBe(1);
  });

  it("never treats an active upload lease as a missing object", async () => {
    const seeded = await seed("active-upload", { active: true });
    const result = await inspectCreatorRecordedStages({ workspaceId: WORKSPACE });
    expect(result.findings).toEqual([{ generationId: seeded.generationId, key: seeded.key, finding: "ACTIVE_UPLOAD" }]);
    expect(state.probes).toBe(0);
  });

  it("recognizes a verified recoverable staged object without resubmission", async () => {
    const seeded = await seed("recoverable");
    state.objects.set(seeded.key, { size: 12, checksum: CHECKSUM });
    const result = await inspectCreatorRecordedStages({ workspaceId: WORKSPACE });
    expect(result.findings[0].finding).toBe("RECOVERABLE_STAGE");
    expect(await query("SELECT * FROM creatorProviderJobs WHERE generationId = ?", [seeded.generationId])).toHaveLength(1);
  });

  it("preserves incomplete pagination and tenant boundaries", async () => {
    const first = await seed("page-1");
    const second = await seed("page-2");
    await seed("other-workspace", { workspace: WORKSPACE + 1 });
    const page1 = await inspectCreatorRecordedStages({ workspaceId: WORKSPACE, maxRows: 1 });
    expect(page1).toMatchObject({ scannedRecords: 1, complete: false, nextAfterGenerationId: first.generationId });
    expect(page1.findings[0].key).toBe(first.key);
    const page2 = await inspectCreatorRecordedStages({
      workspaceId: WORKSPACE, maxRows: 1, afterGenerationId: page1.nextAfterGenerationId,
    });
    expect(page2).toMatchObject({ scannedRecords: 1, complete: true });
    expect(page2.findings[0].key).toBe(second.key);
  });

  it("rejects superseded provider-job ownership before storage probing", async () => {
    const seeded = await seed("old-job");
    await insert(
      "INSERT INTO creatorProviderJobs (workspaceId, creatorProjectId, generationId, provider, providerJobId, status, snapshotJson) VALUES (?, ?, ?, ?, 'new-job', 'SUCCEEDED', '{}')",
      [WORKSPACE, PROJECT, seeded.generationId, PROVIDER],
    );
    const result = await inspectCreatorRecordedStages({ workspaceId: WORKSPACE });
    expect(result.findings[0].finding).toBe("OWNERSHIP_CONFLICT");
    expect(state.probes).toBe(0);
  });

  it("does not classify a checksum mismatch as a missing object", async () => {
    const seeded = await seed("corrupt-object");
    state.objects.set(seeded.key, { size: 12, checksum: "e".repeat(64) });
    const result = await inspectCreatorRecordedStages({ workspaceId: WORKSPACE });
    expect(result.findings[0].finding).toBe("STORAGE_UNVERIFIED");
    expect(state.probes).toBe(1);
  });
});
