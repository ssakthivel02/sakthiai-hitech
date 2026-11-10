import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { createTestDatabase, skipMysqlSuite, type TestDatabase } from "../testing/mysqlTestDb";

const holder = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("../db", async importOriginal => ({
  ...(await importOriginal<typeof import("../db")>()),
  getDb: async () => holder.db,
}));
import { recordProviderSubmission } from "./persistence";

const WORKSPACE = 7511;
const PROJECT = 8611;
const PROVIDER = "google-veo";

describe.skipIf(skipMysqlSuite())("Creator provider job DB uniqueness (disposable MySQL)", () => {
  let d: TestDatabase;
  const query = async (statement: string, values: unknown[] = []) => {
    const [rows] = await d.pool.promise().query<RowDataPacket[]>(statement, values);
    return rows;
  };
  const insert = async (statement: string, values: unknown[] = []) => {
    const [result] = await d.pool.promise().query<ResultSetHeader>(statement, values);
    return result.insertId;
  };
  const generation = (workspaceId = WORKSPACE) => insert(
    "INSERT INTO creatorGenerations (workspaceId, creatorProjectId, kind, provider, model, parametersJson, status) VALUES (?, ?, 'VIDEO', ?, 'test', '{}', 'SUBMISSION_UNKNOWN')",
    [workspaceId, PROJECT, PROVIDER],
  );
  const job = (workspaceId: number, generationId: number, providerJobId: string) => insert(
    "INSERT INTO creatorProviderJobs (workspaceId, creatorProjectId, generationId, provider, providerJobId, status) VALUES (?, ?, ?, ?, ?, 'SUBMITTED')",
    [workspaceId, PROJECT, generationId, PROVIDER, providerJobId],
  );
  const submit = (generationId: number, providerJobId: string, provider = PROVIDER) => recordProviderSubmission({
    workspaceId: WORKSPACE, creatorProjectId: PROJECT, generationId,
    submission: { provider, providerJobId, model: "test", state: "SUBMITTED" as const, raw: {} },
  });

  beforeAll(async () => { d = await createTestDatabase(); holder.db = d.db; });
  afterAll(async () => { await d?.close(); });
  beforeEach(async () => {
    await d.pool.promise().query("DELETE FROM creatorProviderJobs");
    await d.pool.promise().query("DELETE FROM creatorGenerations");
  });

  it("enforces workspace/job uniqueness across different generations", async () => {
    const a = await generation(), b = await generation();
    await job(WORKSPACE, a, "opaque-123");
    await expect(job(WORKSPACE, b, "opaque-123")).rejects.toMatchObject({ code: "ER_DUP_ENTRY" });
    expect(Number((await query("SELECT COUNT(*) AS n FROM creatorProviderJobs WHERE workspaceId = ?", [WORKSPACE]))[0].n)).toBe(1);
  });

  it("allows identical opaque job IDs in different workspaces", async () => {
    const a = await generation(WORKSPACE), b = await generation(WORKSPACE + 1);
    await job(WORKSPACE, a, "shared-tenant-id");
    await job(WORKSPACE + 1, b, "shared-tenant-id");
    expect(Number((await query("SELECT COUNT(*) AS n FROM creatorProviderJobs WHERE providerJobId = 'shared-tenant-id'"))[0].n)).toBe(2);
  });

  it("serializes concurrent submissions and rolls back the losing generation update", async () => {
    const a = await generation(), b = await generation();
    const results = await Promise.allSettled([submit(a, "one-provider-job"), submit(b, "one-provider-job")]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
    const rows = await query("SELECT generationId FROM creatorProviderJobs WHERE workspaceId = ? AND providerJobId = ?", [WORKSPACE, "one-provider-job"]);
    expect(rows).toHaveLength(1);
    const winner = Number(rows[0].generationId);
    const loser = winner === a ? b : a;
    expect((await query("SELECT status FROM creatorGenerations WHERE id = ?", [winner]))[0].status).toBe("SUBMITTED");
    expect((await query("SELECT status FROM creatorGenerations WHERE id = ?", [loser]))[0].status).toBe("SUBMISSION_UNKNOWN");
  });

  it("rejects provider mismatch and malformed job IDs before writing any job", async () => {
    const g = await generation();
    await expect(submit(g, "foreign", "other-provider")).rejects.toThrow("CREATOR_PROVIDER_SUBMISSION_MISMATCH");
    for (const id of ["", " padded ", "x".repeat(513)]) {
      await expect(submit(g, id)).rejects.toThrow("CREATOR_PROVIDER_JOB_ID_INVALID");
    }
    expect(Number((await query("SELECT COUNT(*) AS n FROM creatorProviderJobs"))[0].n)).toBe(0);
  });

  it("fails migration on legacy duplicates without deleting either provider-job record", async () => {
    const a = await generation(), b = await generation();
    await d.pool.promise().query("ALTER TABLE creatorProviderJobs DROP INDEX creatorProviderJobs_workspace_job_uq");
    try {
      await job(WORKSPACE, a, "legacy-duplicate");
      await job(WORKSPACE, b, "legacy-duplicate");
      await expect(d.pool.promise().query(
        "ALTER TABLE creatorProviderJobs ADD CONSTRAINT creatorProviderJobs_workspace_job_uq UNIQUE (workspaceId, providerJobId)",
      )).rejects.toMatchObject({ code: "ER_DUP_ENTRY" });
      expect(Number((await query("SELECT COUNT(*) AS n FROM creatorProviderJobs WHERE providerJobId = 'legacy-duplicate'"))[0].n)).toBe(2);
    } finally {
      await d.pool.promise().query("DELETE FROM creatorProviderJobs WHERE providerJobId = 'legacy-duplicate'");
      await d.pool.promise().query(
        "ALTER TABLE creatorProviderJobs ADD CONSTRAINT creatorProviderJobs_workspace_job_uq UNIQUE (workspaceId, providerJobId)",
      );
    }
  });
});
