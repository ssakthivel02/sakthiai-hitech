import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDatabase, skipMysqlSuite, type TestDatabase } from "../testing/mysqlTestDb";

const holder = vi.hoisted(() => ({
  db: undefined as unknown,
  roles: new Map<number, "owner" | "member">(),
  verify: vi.fn(async (_key: string, _size: number, _sha: string) => undefined),
}));
vi.mock("../db", async original => ({
  ...(await original<typeof import("../db")>()),
  getDb: async () => holder.db,
  getWorkspaceForUser: async (userId: number, workspaceId: number) =>
    workspaceId === 7 && holder.roles.has(userId) ? { id: 7 } : undefined,
  getWorkspaceRole: async (userId: number, workspaceId: number) =>
    workspaceId === 7 ? holder.roles.get(userId) : undefined,
}));
vi.mock("../storage", async original => ({
  ...(await original<typeof import("../storage")>()),
  storageVerifySha256: (...args: [string, number, string]) => holder.verify(...args),
}));

import { appRouter } from "../routers";
import type { TrpcContext } from "../_core/context";

const sha = "a".repeat(64);
function caller(userId: number) {
  const now = new Date();
  return appRouter.createCaller({
    req: {} as TrpcContext["req"],
    res: { headersSent: false, setHeader: () => undefined } as unknown as TrpcContext["res"],
    requestId: "generated-asset-review",
    user: { id: userId, openId: `review-${userId}`, name: "test", email: "test@example.invalid",
      loginMethod: "google", role: "user", createdAt: now, updatedAt: now, lastSignedIn: now },
  });
}

describe.skipIf(skipMysqlSuite())("generated IMAGE/VIDEO owner review (real MySQL)", { timeout: 60_000 }, () => {
  let database: TestDatabase;
  let projectId: number;
  const run = (statement: ReturnType<typeof sql>) => database.db.execute(statement);
  const one = async <T>(statement: ReturnType<typeof sql>) =>
    ((await run(statement)) as unknown as [T[]])[0][0] as T;

  beforeAll(async () => {
    database = await createTestDatabase();
    holder.db = database.db;
    holder.roles.set(501, "owner");
    holder.roles.set(502, "member");
    await run(sql`INSERT INTO creatorProjects (workspaceId, name) VALUES (7, 'generated-visual-review')`);
    projectId = (await one<{ id: number }>(sql`SELECT id FROM creatorProjects WHERE name = 'generated-visual-review'`)).id;
  });
  beforeEach(() => { holder.verify.mockReset(); holder.verify.mockResolvedValue(undefined); });
  afterAll(async () => { await database?.close(); });

  async function fixture(label: string, type: "IMAGE" | "VIDEO" = "IMAGE") {
    const mime = type === "IMAGE" ? "image/png" : "video/mp4";
    const ext = type === "IMAGE" ? "png" : "mp4";
    await run(sql`INSERT INTO creatorGenerations (workspaceId, creatorProjectId, kind, provider, model, parametersJson, status)
      VALUES (7, ${projectId}, ${type}, 'google', 'test-model', '{}', 'SUCCEEDED')`);
    const generationId = (await one<{ id: number }>(sql`SELECT MAX(id) AS id FROM creatorGenerations WHERE creatorProjectId = ${projectId}`)).id;
    const providerJobId = `job-${generationId}-${label}`;
    await run(sql`INSERT INTO creatorProviderJobs (workspaceId, creatorProjectId, generationId, provider, providerJobId, status)
      VALUES (7, ${projectId}, ${generationId}, 'google', ${providerJobId}, 'SUCCEEDED')`);
    const provenance = JSON.stringify({ schemaVersion: 1, creatorProjectId: projectId, shotId: null,
      generationId, provider: "google", providerJobId, checksumSha256: sha });
    const storageKey = `creator/7/${projectId}/staged/generation-${generationId}/${label}.${ext}`;
    await run(sql`INSERT INTO creatorAssets (workspaceId, creatorProjectId, assetType, mimeType, storageKey,
      checksumSha256, byteSize, immutable, provenanceJson, reviewDecision)
      VALUES (7, ${projectId}, ${type}, ${mime}, ${storageKey}, ${sha}, 100, 1, ${provenance}, 'PENDING')`);
    const assetId = (await one<{ id: number }>(sql`SELECT id FROM creatorAssets WHERE storageKey = ${storageKey}`)).id;
    await run(sql`UPDATE creatorGenerations SET outputAssetId = ${assetId} WHERE id = ${generationId}`);
    return { workspaceId: 7, creatorProjectId: projectId, assetId, generationId,
      expectedChecksumSha256: sha, confirmAssetReviewed: true as const, notes: "Reviewed the exact visual artifact" };
  }
  const counts = async (assetId: number) => ({
    status: (await one<{ reviewDecision: string }>(sql`SELECT reviewDecision FROM creatorAssets WHERE id = ${assetId}`)).reviewDecision,
    reviews: Number((await one<{ n: number }>(sql`SELECT COUNT(*) AS n FROM creatorReviews WHERE assetId = ${assetId}`)).n),
  });

  it("owner approval verifies immutable stored bytes and makes IMAGE timeline eligible", async () => {
    const base = await fixture("approve-image");
    await expect(caller(501).creator.review.reviewGeneratedAsset({ ...base, decision: "APPROVE" }))
      .resolves.toMatchObject({ reviewDecision: "APPROVED", timelineEligible: true, finalMaster: false, publishApproved: false });
    expect(holder.verify).toHaveBeenCalledWith(expect.stringContaining("creator/7/"), 100, sha);
    expect(await counts(base.assetId)).toEqual({ status: "APPROVED", reviews: 1 });
    await expect(caller(501).creator.review.reviewGeneratedAsset({ ...base, decision: "APPROVE" }))
      .rejects.toMatchObject({ message: "CREATOR_GENERATED_REVIEW_ALREADY_DECIDED" });
    expect(await counts(base.assetId)).toEqual({ status: "APPROVED", reviews: 1 });
  });
  it("owner may reject VIDEO when media is missing, without falsely claiming verified bytes", async () => {
    const base = await fixture("reject-video", "VIDEO");
    holder.verify.mockRejectedValue(new Error("NoSuchKey"));
    await expect(caller(501).creator.review.reviewGeneratedAsset({ ...base, decision: "REJECT" }))
      .resolves.toMatchObject({ reviewDecision: "REJECTED", timelineEligible: false });
    expect(holder.verify).not.toHaveBeenCalled();
    expect(await counts(base.assetId)).toEqual({ status: "REJECTED", reviews: 1 });
  });
  it("denies members and cross-tenant users without writes or storage access", async () => {
    const base = await fixture("auth-denied");
    await expect(caller(502).creator.review.reviewGeneratedAsset({ ...base, decision: "APPROVE" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller(999).creator.review.reviewGeneratedAsset({ ...base, decision: "REJECT" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await counts(base.assetId)).toEqual({ status: "PENDING", reviews: 0 });
    expect(holder.verify).not.toHaveBeenCalled();
  });
  it("fails closed on storage corruption without writing a review", async () => {
    const base = await fixture("storage-corrupt");
    holder.verify.mockRejectedValue(new Error("CREATOR_STORAGE_CHECKSUM_MISMATCH"));
    await expect(caller(501).creator.review.reviewGeneratedAsset({ ...base, decision: "APPROVE" }))
      .rejects.toBeTruthy();
    expect(await counts(base.assetId)).toEqual({ status: "PENDING", reviews: 0 });
  });
  it("refuses a superseding provider job without mutating the asset", async () => {
    const base = await fixture("superseded");
    await run(sql`INSERT INTO creatorProviderJobs (workspaceId, creatorProjectId, generationId, provider, providerJobId, status)
      VALUES (7, ${projectId}, ${base.generationId}, 'google', ${`replacement-${base.generationId}`}, 'SUCCEEDED')`);
    await expect(caller(501).creator.review.reviewGeneratedAsset({ ...base, decision: "APPROVE" }))
      .rejects.toMatchObject({ message: "CREATOR_GENERATED_REVIEW_PROVIDER_JOB_MISMATCH" });
    expect(await counts(base.assetId)).toEqual({ status: "PENDING", reviews: 0 });
  });
  it("serializes concurrent owner decisions into exactly one review row", async () => {
    const base = await fixture("concurrent");
    const results = await Promise.allSettled([
      caller(501).creator.review.reviewGeneratedAsset({ ...base, decision: "APPROVE" }),
      caller(501).creator.review.reviewGeneratedAsset({ ...base, decision: "REJECT" }),
    ]);
    expect(results.filter(item => item.status === "fulfilled")).toHaveLength(1);
    expect(await counts(base.assetId)).toMatchObject({ reviews: 1 });
  });
});
