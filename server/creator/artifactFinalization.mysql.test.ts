import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { createTestDatabase, skipMysqlSuite, type TestDatabase } from "../testing/mysqlTestDb";
import type { CreatorMediaProvider, CreatorProviderArtifact } from "./types";

const state = vi.hoisted(() => ({
  db: undefined as unknown,
  objects: new Map<string, Uint8Array>(),
  sequence: 0,
  afterPut: null as null | (() => Promise<void>),
  failPut: false,
}));
vi.mock("../db", async importOriginal => ({
  ...(await importOriginal<typeof import("../db")>()),
  getDb: async () => state.db,
}));
vi.mock("../storage", async () => {
  const { createHash } = await import("node:crypto");
  return {
    storagePutCreatorStagedObject: async (key: string, data: Uint8Array, _mimeType: string) => {
      if (state.failPut) throw new Error("INJECTED_STORAGE_UNAVAILABLE");
      if (state.objects.has(key)) {
        const error = new Error("PreconditionFailed") as Error & { $metadata?: { httpStatusCode: number } };
        error.name = "PreconditionFailed"; error.$metadata = { httpStatusCode: 412 };
        throw error;
      }
      state.sequence++;
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
      if (!data) { const error = new Error("NoSuchKey"); error.name = "NoSuchKey"; throw error; }
      if (data.byteLength !== size || createHash("sha256").update(data).digest("hex") !== checksum)
        throw new Error("CREATOR_STORED_MEDIA_CHECKSUM_MISMATCH");
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
    await d.pool.promise().query("DELETE FROM creatorArtifactLeases");
    await d.pool.promise().query("DELETE FROM creatorAssets");
    await d.pool.promise().query("DELETE FROM creatorProviderJobs");
    await d.pool.promise().query("DELETE FROM creatorGenerations");
    state.objects.clear();
    state.sequence = 0;
    state.afterPut = null;
    state.failPut = false;
  });

  it("serializes competing finalizers to one committed asset and reuses the winner", async () => {
    const generationId = await seed("same-job");
    const outcomes = await Promise.allSettled(Array.from({ length: 6 }, () => persist(generationId, "same-job")));
    const successes = outcomes.filter(result => result.status === "fulfilled").map(result => result.value);
    const errors = outcomes.filter(result => result.status === "rejected").map(result => String(result.reason));
    expect(successes.length).toBeGreaterThanOrEqual(1);
    expect(successes.filter(result => !result.reused)).toHaveLength(1);
    expect(new Set(successes.map(result => result.assetId)).size).toBe(1);
    for (const error of errors) expect(error).toMatch(/CREATOR_ARTIFACT_LEASE_BUSY|CREATOR_ARTIFACT_ALREADY_FINALIZED/);
    expect(await assetCount(generationId)).toBe(1);
    expect(state.sequence).toBe(1); // exclusive upload: no competing orphan objects
    const [generation] = await query("SELECT status, outputAssetId FROM creatorGenerations WHERE id = ?", [generationId]);
    expect(generation.status).toBe("SUCCEEDED");
    expect(generation.outputAssetId).toBe(successes[0].assetId);
    expect(await query("SELECT * FROM creatorArtifactLeases WHERE generationId = ?", [generationId])).toHaveLength(0);
  });

  it("refuses an active claim before provider retrieval or storage upload", async () => {
    const generationId = await seed("busy-job");
    await insert(
      "INSERT INTO creatorArtifactLeases (generationId, workspaceId, creatorProjectId, providerJobId, leaseToken, leaseUntil) VALUES (?, ?, ?, 'busy-job', 'existing-token', DATE_ADD(NOW(3), INTERVAL 5 MINUTE))",
      [generationId, WORKSPACE, PROJECT],
    );
    await expect(persist(generationId, "busy-job")).rejects.toThrow("CREATOR_ARTIFACT_LEASE_BUSY");
    expect(state.sequence).toBe(0);
    expect(await assetCount(generationId)).toBe(0);
  });

  it("takes over an expired claim and finalizes without another provider submission", async () => {
    const generationId = await seed("expired-job");
    await insert(
      "INSERT INTO creatorArtifactLeases (generationId, workspaceId, creatorProjectId, providerJobId, leaseToken, leaseUntil) VALUES (?, ?, ?, 'expired-job', 'old-token', DATE_SUB(NOW(3), INTERVAL 1 SECOND))",
      [generationId, WORKSPACE, PROJECT],
    );
    const result = await persist(generationId, "expired-job");
    expect(result.reused).toBe(false);
    expect(state.sequence).toBe(1);
    expect(await query("SELECT * FROM creatorArtifactLeases WHERE generationId = ?", [generationId])).toHaveLength(0);
    expect(await query("SELECT * FROM creatorProviderJobs WHERE generationId = ?", [generationId])).toHaveLength(1);
  });

  it("releases its own lease on storage failure and retries artifact-only", async () => {
    const generationId = await seed("storage-retry-job");
    state.failPut = true;
    await expect(persist(generationId, "storage-retry-job")).rejects.toThrow("INJECTED_STORAGE_UNAVAILABLE");
    const released = await query("SELECT leaseUntil FROM creatorArtifactLeases WHERE generationId = ?", [generationId]);
    expect(released).toHaveLength(1);
    expect(new Date(released[0].leaseUntil).getTime()).toBeLessThan(Date.now());
    expect(await assetCount(generationId)).toBe(0);
    state.failPut = false;
    const recovered = await persist(generationId, "storage-retry-job");
    expect(recovered.reused).toBe(false);
    expect(state.sequence).toBe(1);
    expect(await query("SELECT * FROM creatorProviderJobs WHERE generationId = ?", [generationId])).toHaveLength(1);
  });

  it("rejects a stolen lease at finalization and never releases the replacement token", async () => {
    const generationId = await seed("stolen-job");
    state.afterPut = async () => {
      await d.pool.promise().query(
        "UPDATE creatorArtifactLeases SET leaseToken = 'replacement-token', leaseUntil = DATE_ADD(NOW(3), INTERVAL 5 MINUTE) WHERE generationId = ?",
        [generationId],
      );
    };
    await expect(persist(generationId, "stolen-job")).rejects.toThrow("CREATOR_ARTIFACT_LEASE_LOST");
    expect(await assetCount(generationId)).toBe(0);
    const leases = await query("SELECT leaseToken FROM creatorArtifactLeases WHERE generationId = ?", [generationId]);
    expect(leases[0].leaseToken).toBe("replacement-token");
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
    await expect(persist(generationId, "verified-job")).rejects.toThrow("NoSuchKey");
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
    const [stage] = await query("SELECT stagedStorageKey FROM creatorArtifactLeases WHERE generationId = ?", [generationId]);
    expect(stage.stagedStorageKey).toMatch(/^creator\\//);
    const recovered = await persist(generationId, "rollback-job");
    expect(recovered.storageKey).toBe(stage.stagedStorageKey);
    expect(state.sequence).toBe(1); // no second object PUT after failed DB finalization
    expect(await assetCount(generationId)).toBe(1);
  });
  it("recovers expired lease after a completed upload without another PUT", async () => {
    const generationId = await seed("expired-after-put");
    state.afterPut = async () => {
      await d.pool.promise().query(
        "UPDATE creatorArtifactLeases SET leaseUntil = DATE_SUB(NOW(3), INTERVAL 1 SECOND) WHERE generationId = ?",
        [generationId]);
    };
    await expect(persist(generationId, "expired-after-put")).rejects.toThrow("CREATOR_ARTIFACT_LEASE_LOST");
    const result = await persist(generationId, "expired-after-put");
    expect(result.reused).toBe(false);
    expect(state.sequence).toBe(1);
    expect(await assetCount(generationId)).toBe(1);
  });

  it("refuses corrupt staged bytes rather than replacing the object", async () => {
    const generationId = await seed("corrupt-after-put");
    state.afterPut = async () => {
      for (const [key, bytes] of state.objects)
        state.objects.set(key, new Uint8Array(bytes.map((value, i) => i ? value : value ^ 255)));
    };
    await expect(persist(generationId, "corrupt-after-put")).rejects.toThrow("CREATOR_STORED_MEDIA_CHECKSUM_MISMATCH");
    await expect(persist(generationId, "corrupt-after-put")).rejects.toThrow("CREATOR_STORED_MEDIA_CHECKSUM_MISMATCH");
    expect(state.sequence).toBe(1);
    expect(await assetCount(generationId)).toBe(0);
  });

});
