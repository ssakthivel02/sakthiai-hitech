import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { createTestDatabase, skipMysqlSuite, type TestDatabase } from "../testing/mysqlTestDb";
import type { CreatorMediaProvider, CreatorProviderArtifact } from "./types";

const state = vi.hoisted(() => ({
  db: undefined as unknown,
  objects: new Map<string, Uint8Array>(),
  sequence: 0,
  afterPut: null as null | (() => Promise<void>),
}));
vi.mock("../db", async importOriginal => ({
  ...(await importOriginal<typeof import("../db")>()),
  getDb: async () => state.db,
}));
vi.mock("../storage", async () => {
  const { createHash } = await import("node:crypto");
  return {
    storagePut: async (name: string, data: Uint8Array, _mimeType: string) => {
      const key = `${name}-${++state.sequence}`;
      state.objects.set(key, new Uint8Array(data));
      if (state.afterPut) {
        const callback = state.afterPut;
        state.afterPut = null;
        await callback();
      }
      return { key };
    },
    storageVerifySha256: async (key: string, size: number, checksum: string) => {
      const data = state.objects.get(key);
      if (!data || data.byteLength !== size || createHash("sha256").update(data).digest("hex") !== checksum) {
        throw new Error("CREATOR_STORED_MEDIA_CHECKSUM_MISMATCH");
      }
    },
  };
});
import { persistCreatorGenerationArtifact } from "./artifactPersistence";

const WORKSPACE = 6417;
const PROJECT = 9327;
const PROVIDER = "google-veo";
const artifact: CreatorProviderArtifact = { mimeType: "image/png", dataBase64: "AA==" };
const provider = {
  id: PROVIDER,
  fetchArtifact: async () => ({ mimeType: "image/png", data: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1]) }),
} as unknown as CreatorMediaProvider;

describe.skipIf(skipMysqlSuite())("Creator artifact finalization ownership (disposable MySQL)", () => {
  let d: TestDatabase;
  const query = async (sql: string, values: unknown[] = []) => {
    const [rows] = await d.pool.promise().query<RowDataPacket[]>(sql, values);
    return rows;
  };
  const insert = async (sql: string, values: unknown[] = []) => {
    const [result] = await d.pool.promise().query<ResultSetHeader>(sql, values);
    return result.insertId;
  };
  const seed = async (jobId: string) => {
    const generationId = await insert(
      "INSERT INTO creatorGenerations (workspaceId, creatorProjectId, kind, provider, model, parametersJson, status) VALUES (?, ?, 'IMAGE', ?, 'test', '{}', 'RUNNING')",
      [WORKSPACE, PROJECT, PROVIDER],
    );
    await insert(
      "INSERT INTO creatorProviderJobs (workspaceId, creatorProjectId, generationId, provider, providerJobId, status, snapshotJson) VALUES (?, ?, ?, ?, ?, 'SUCCEEDED', '{}')",
      [WORKSPACE, PROJECT, generationId, PROVIDER, jobId],
    );
    return generationId;
  };
  const persist = (generationId: number, providerJobId: string) => persistCreatorGenerationArtifact({
    workspaceId: WORKSPACE, generationId, providerJobId, provider, artifact,
  });
  const assetCount = async (generationId: number) => {
    const rows = await query("SELECT COUNT(*) AS total FROM creatorAssets WHERE provenanceJson LIKE ?", [`%"generationId":${generationId},%`]);
    return Number(rows[0].total);
  };

  beforeAll(async () => { d = await createTestDatabase(); state.db = d.db; });
  afterAll(async () => { await d?.close(); });
  beforeEach(async () => {
    await d.pool.promise().query("DELETE FROM creatorAssets");
    await d.pool.promise().query("DELETE FROM creatorProviderJobs");
    await d.pool.promise().query("DELETE FROM creatorGenerations");
    state.objects.clear();
    state.sequence = 0;
    state.afterPut = null;
  });

  it("serializes competing finalizers to one committed asset and reuses the winner", async () => {
    const generationId = await seed("same-job");
    const results = await Promise.all(Array.from({ length: 6 }, () => persist(generationId, "same-job")));
    expect(new Set(results.map(result => result.assetId)).size).toBe(1);
    expect(results.filter(result => !result.reused)).toHaveLength(1);
    expect(results.filter(result => result.reused)).toHaveLength(5);
    expect(await assetCount(generationId)).toBe(1);
    const [generation] = await query("SELECT status, outputAssetId FROM creatorGenerations WHERE id = ?", [generationId]);
    expect(generation.status).toBe("SUCCEEDED");
    expect(generation.outputAssetId).toBe(results[0].assetId);
    // Parallel storagePut may leave unreferenced objects: reconciliation owns their quarantine.
  });

  it("rejects a provider job superseded between storage upload and transaction", async () => {
    const generationId = await seed("old-job");
    state.afterPut = async () => {
      await insert(
        "INSERT INTO creatorProviderJobs (workspaceId, creatorProjectId, generationId, provider, providerJobId, status, snapshotJson) VALUES (?, ?, ?, ?, 'new-job', 'SUCCEEDED', '{}')",
        [WORKSPACE, PROJECT, generationId, PROVIDER],
      );
    };
    await expect(persist(generationId, "old-job")).rejects.toThrow("CREATOR_ARTIFACT_PROVIDER_JOB_MISMATCH");
    expect(await assetCount(generationId)).toBe(0);
    const [generation] = await query("SELECT status, outputAssetId FROM creatorGenerations WHERE id = ?", [generationId]);
    expect(generation).toMatchObject({ status: "RUNNING", outputAssetId: null });
  });

  it("refuses to reuse a committed asset whose bytes have disappeared", async () => {
    const generationId = await seed("verified-job");
    const first = await persist(generationId, "verified-job");
    state.objects.delete(first.storageKey);
    await expect(persist(generationId, "verified-job")).rejects.toThrow("CREATOR_STORED_MEDIA_CHECKSUM_MISMATCH");
    expect(await assetCount(generationId)).toBe(1);
  });

  it("rolls back asset creation if the generation update fails", async () => {
    const generationId = await seed("rollback-job");
    await d.pool.promise().query(
      "CREATE TRIGGER creatorArtifactFinalizeAbort BEFORE UPDATE ON creatorGenerations FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'injected finalization failure'",
    );
    try {
      await expect(persist(generationId, "rollback-job")).rejects.toThrow();
      expect(await assetCount(generationId)).toBe(0);
      const [generation] = await query("SELECT status, outputAssetId FROM creatorGenerations WHERE id = ?", [generationId]);
      expect(generation).toMatchObject({ status: "RUNNING", outputAssetId: null });
    } finally {
      await d.pool.promise().query("DROP TRIGGER IF EXISTS creatorArtifactFinalizeAbort");
    }
  });
});
