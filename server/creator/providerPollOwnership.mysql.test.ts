import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { createTestDatabase, skipMysqlSuite, type TestDatabase } from "../testing/mysqlTestDb";
import { isCreatorArtifactJobOwnershipError } from "./artifactJobOwnership";

const holder = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("../db", async importOriginal => ({
  ...(await importOriginal<typeof import("../db")>()),
  getDb: async () => holder.db,
}));
import { recordProviderPoll, recordProviderSubmission } from "./persistence";

const WORKSPACE = 6307;
const PROJECT = 9311;
const PROVIDER = "google-veo";
const poll = (providerJobId: string) => ({
  providerJobId, state: "SUCCEEDED" as const, raw: { observed: "SUCCEEDED" }, artifacts: [],
});

describe.skipIf(skipMysqlSuite())("Creator provider poll ownership (disposable MySQL)", () => {
  let d: TestDatabase;
  const query = async (statement: string, values: unknown[] = []) => {
    const [rows] = await d.pool.promise().query<RowDataPacket[]>(statement, values);
    return rows;
  };
  const insert = async (statement: string, values: unknown[] = []) => {
    const [result] = await d.pool.promise().query<ResultSetHeader>(statement, values);
    return result.insertId;
  };
  const generation = async (status = "SUBMITTED") => insert(
    "INSERT INTO creatorGenerations (workspaceId, creatorProjectId, kind, provider, model, parametersJson, status) VALUES (?, ?, 'VIDEO', ?, 'test', '{}', ?)",
    [WORKSPACE, PROJECT, PROVIDER, status],
  );
  const job = async (generationId: number, providerJobId: string, status = "SUBMITTED", workspaceId = WORKSPACE) => insert(
    "INSERT INTO creatorProviderJobs (workspaceId, creatorProjectId, generationId, provider, providerJobId, status, snapshotJson) VALUES (?, ?, ?, ?, ?, ?, '{}')",
    [workspaceId, PROJECT, generationId, PROVIDER, providerJobId, status],
  );
  const snapshot = async (generationId: number, jobId: number) => ({
    generation: (await query("SELECT status, outputAssetId FROM creatorGenerations WHERE id = ?", [generationId]))[0],
    job: (await query("SELECT status FROM creatorProviderJobs WHERE id = ?", [jobId]))[0],
  });

  beforeAll(async () => { d = await createTestDatabase(); holder.db = d.db; });
  afterAll(async () => { await d?.close(); });
  beforeEach(async () => {
    await d.pool.promise().query("DELETE FROM creatorProviderJobs");
    await d.pool.promise().query("DELETE FROM creatorGenerations");
  });

  it("quarantines a superseded job without mutating the generation", async () => {
    const g = await generation();
    const old = await job(g, "old-job");
    await job(g, "new-job");
    await expect(recordProviderPoll({ workspaceId: WORKSPACE, providerJobId: "old-job", poll: poll("old-job") }))
      .rejects.toThrow("CREATOR_PROVIDER_JOB_SUPERSEDED");
    expect(await snapshot(g, old)).toMatchObject({ generation: { status: "SUBMITTED" }, job: { status: "SUBMITTED" } });
  });

  it("serializes eight concurrent duplicate pollers without creating new jobs", async () => {
    const g = await generation("RUNNING");
    const j = await job(g, "same-job", "RUNNING");
    const results = await Promise.all(Array.from({ length: 8 }, () =>
      recordProviderPoll({ workspaceId: WORKSPACE, providerJobId: "same-job", poll: poll("same-job") }),
    ));
    expect(results.every(r => r.generationId === g && r.generationState === "RUNNING")).toBe(true);
    expect(await snapshot(g, j)).toMatchObject({ generation: { status: "RUNNING" }, job: { status: "SUCCEEDED" } });
    expect((await query("SELECT COUNT(*) AS total FROM creatorProviderJobs WHERE generationId = ?", [g]))[0].total).toBe(1);
  });

  it("rolls back provider state if the generation update fails", async () => {
    const g = await generation();
    const j = await job(g, "rollback-job");
    await d.pool.promise().query(
      "CREATE TRIGGER creatorProviderPollAbort BEFORE UPDATE ON creatorGenerations FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'injected generation failure'",
    );
    try {
      await expect(recordProviderPoll({ workspaceId: WORKSPACE, providerJobId: "rollback-job", poll: poll("rollback-job") }))
        .rejects.toThrow();
      expect(await snapshot(g, j)).toMatchObject({ generation: { status: "SUBMITTED" }, job: { status: "SUBMITTED" } });
    } finally {
      await d.pool.promise().query("DROP TRIGGER IF EXISTS creatorProviderPollAbort");
    }
  });

  it("rejects foreign poll payloads before any mutation", async () => {
    const g = await generation();
    const j = await job(g, "correct-job");
    await expect(recordProviderPoll({ workspaceId: WORKSPACE, providerJobId: "correct-job", poll: poll("foreign-job") }))
      .rejects.toThrow("CREATOR_PROVIDER_POLL_JOB_MISMATCH");
    expect(await snapshot(g, j)).toMatchObject({ generation: { status: "SUBMITTED" }, job: { status: "SUBMITTED" } });
  });

  it("never reopens an already persisted generation", async () => {
    const g = await generation("SUCCEEDED");
    const j = await job(g, "final-job", "SUCCEEDED");
    await d.pool.promise().query("UPDATE creatorGenerations SET outputAssetId = 991 WHERE id = ?", [g]);
    await expect(recordProviderPoll({ workspaceId: WORKSPACE, providerJobId: "final-job", poll: poll("final-job") }))
      .rejects.toThrow("CREATOR_PROVIDER_POLL_ALREADY_FINALIZED");
    expect(await snapshot(g, j)).toMatchObject({ generation: { status: "SUCCEEDED", outputAssetId: 991 }, job: { status: "SUCCEEDED" } });
  });

  it("rejects duplicate provider job IDs within one workspace, but permits tenant reuse", async () => {
    const a = await generation(), b = await generation();
    await job(a, "reused");
    await expect(job(b, "reused")).rejects.toMatchObject({ code: "ER_DUP_ENTRY" });
    const c = await generation();
    const cJob = await job(c, "tenant-job");
    await job(c, "tenant-job", "SUBMITTED", WORKSPACE + 1);
    await recordProviderPoll({ workspaceId: WORKSPACE, providerJobId: "tenant-job", poll: poll("tenant-job") });
    expect((await snapshot(c, cJob)).job.status).toBe("SUCCEEDED");
  });

  it("accepts a new submitted job followed by its own poll", async () => {
    const g = await generation("SUBMISSION_UNKNOWN");
    await recordProviderSubmission({
      workspaceId: WORKSPACE, creatorProjectId: PROJECT, generationId: g,
      submission: { provider: PROVIDER, providerJobId: "submitted-job", model: "test", state: "SUBMITTED", raw: {} },
    });
    expect((await recordProviderPoll({ workspaceId: WORKSPACE, providerJobId: "submitted-job", poll: poll("submitted-job") })).generationState)
      .toBe("RUNNING");
  });

  it("treats ownership conflicts as non-retryable", () => {
    for (const code of ["CREATOR_PROVIDER_JOB_SUPERSEDED", "CREATOR_PROVIDER_POLL_JOB_MISMATCH",
      "CREATOR_PROVIDER_JOB_AMBIGUOUS", "CREATOR_PROVIDER_POLL_ALREADY_FINALIZED"]) {
      expect(isCreatorArtifactJobOwnershipError(new Error(code))).toBe(true);
    }
  });
});
