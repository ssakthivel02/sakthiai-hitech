import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDatabase, skipMysqlSuite, type TestDatabase } from "../testing/mysqlTestDb";

/**
 * Real SQL + the real tRPC router: creator.review.{quality, humanTamil, humanVisual, finalizeMaster} are consequential
 * decisions on a 16:9 master (a verdict that can reject it, a final PASS/REJECT, or promotion to final master), so they
 * must be workspace-owner only, like creator.speechAvatar.reviewSpeech and creator.timeline.reviewVerticalDerivative.
 * This proves: owners can approve; ordinary members cannot approve, reject or finalize and create no side effects;
 * cross-tenant users are denied; and the existing owner-authorized flow (quality -> Tamil -> visual -> finalize)
 * still works end to end.
 */
const holder = vi.hoisted(() => ({ db: undefined as unknown, roles: new Map<number, "owner" | "member">(), verify: vi.fn(async (_key: string, _size: number, _sha: string) => undefined) }));
vi.mock("../storage", async importOriginal => ({
  ...(await importOriginal<typeof import("../storage")>()),
  storageVerifySha256: (...args: [string, number, string]) => holder.verify(...args),
}));
vi.mock("../db", async importOriginal => ({
  ...(await importOriginal<typeof import("../db")>()),
  getDb: async () => holder.db,
  getWorkspaceForUser: async (userId: number, workspaceId: number) => (workspaceId === 7 && holder.roles.has(userId) ? { id: 7 } : undefined),
  getWorkspaceRole: async (userId: number, workspaceId: number) => (workspaceId === 7 ? holder.roles.get(userId) : undefined),
}));

import { appRouter } from "../routers";
import type { TrpcContext } from "../_core/context";

function caller(userId: number) {
  const now = new Date();
  return appRouter.createCaller({
    req: {} as TrpcContext["req"], res: { headersSent: false, setHeader: () => undefined } as unknown as TrpcContext["res"], requestId: "review-auth",
    user: { id: userId, openId: `u${userId}`, name: "u", email: "u@example.invalid", loginMethod: "google", role: "user", createdAt: now, updatedAt: now, lastSignedIn: now },
  });
}

const dims = { "VQ-CONTENT-01": 5, "VQ-TEMPORAL-01": 5, "VQ-IDENTITY-01": 5, "VQ-VISUAL-01": 5, "VQ-CAMERA-01": 5, "VQ-AUDIO-01": 5, "VQ-TEXT-01": 5, "VQ-DELIVERY-01": 5 };

describe.skipIf(skipMysqlSuite())("16:9 master review authorization (real SQL)", { timeout: 60_000 }, () => {
  let database: TestDatabase;
  const run = (s: ReturnType<typeof sql>) => database.db.execute(s);
  const one = async <T>(s: ReturnType<typeof sql>) => ((await database.db.execute(s)) as unknown as [T[]])[0][0] as T;
  const ids: Record<string, number> = {};

  beforeAll(async () => {
    database = await createTestDatabase();
    holder.db = database.db;
    holder.roles.set(501, "owner");
    holder.roles.set(502, "member");
    await run(sql`INSERT INTO creatorProjects (workspaceId, name) VALUES (7, 'review-auth')`);
    ids.project = (await one<{ id: number }>(sql`SELECT id FROM creatorProjects WHERE name = 'review-auth'`)).id;
    await run(sql`INSERT INTO creatorAssets (workspaceId, creatorProjectId, assetType, mimeType, storageKey, checksumSha256, byteSize, immutable, provenanceJson, reviewDecision) VALUES
      (7, ${ids.project}, 'AUDIO_MASTER', 'audio/wav', 'a/master.wav', ${"a".repeat(64)}, 10, 1, '{"durationMs":4000}', 'APPROVED')`);
    ids.audio = (await one<{ id: number }>(sql`SELECT id FROM creatorAssets WHERE storageKey = 'a/master.wav'`)).id;
    await run(sql`INSERT INTO creatorTimelines (workspaceId, creatorProjectId, name, audioMasterAssetId, width, height, fps) VALUES (7, ${ids.project}, 'main', ${ids.audio}, 1920, 1080, 24)`);
    ids.timeline = (await one<{ id: number }>(sql`SELECT id FROM creatorTimelines WHERE creatorProjectId = ${ids.project}`)).id;
  });
  afterAll(async () => { await database?.close(); });

  async function freshMaster(label: string, outputEvidence: unknown = { width: 1920, height: 1080, fps: 24, durationSeconds: 4, hasAudio: true }) {
    const provenance = JSON.stringify({ source: "deterministic-creator-render", timelineId: ids.timeline, audioMasterAssetId: ids.audio, audioMasterChecksumSha256: "a".repeat(64), width: 1920, height: 1080, fps: 24, durationMs: 4000, outputEvidence });
    await run(sql`INSERT INTO creatorAssets (workspaceId, creatorProjectId, assetType, mimeType, storageKey, checksumSha256, byteSize, immutable, provenanceJson, reviewDecision) VALUES
      (7, ${ids.project}, 'RENDER', 'video/mp4', ${`r/${label}.mp4`}, ${createHash("sha256").update(label).digest("hex")}, 1000, 1, ${provenance}, 'PENDING')`);
    return (await one<{ id: number }>(sql`SELECT id FROM creatorAssets WHERE storageKey = ${`r/${label}.mp4`}`)).id;
  }
  const counts = async (assetId: number) => ({
    reviews: Number((await one<{ n: number }>(sql`SELECT COUNT(*) AS n FROM creatorReviews WHERE assetId = ${assetId}`)).n),
    reviewDecision: (await one<{ reviewDecision: string }>(sql`SELECT reviewDecision FROM creatorAssets WHERE id = ${assetId}`)).reviewDecision,
  });

  it("denies a non-owner member on all four mutations, with no review row and no change to the asset", async () => {
    const assetId = await freshMaster("member-denied");
    const before = await counts(assetId);
    const base = { workspaceId: 7, creatorProjectId: ids.project, assetId };
    await expect(caller(502).creator.review.quality({ ...base, reviewerType: "HUMAN", sourcePromptOrStoryboard: "approved storyboard", dimensionScores: dims, criticalDefects: [] }))
      .rejects.toMatchObject({ code: "FORBIDDEN", message: "CREATOR_WORKSPACE_OWNER_REQUIRED" });
    await expect(caller(502).creator.review.humanTamil({ ...base, decision: "PASS", notes: "checked" })).rejects.toMatchObject({ code: "FORBIDDEN", message: "CREATOR_WORKSPACE_OWNER_REQUIRED" });
    await expect(caller(502).creator.review.humanVisual({ ...base, decision: "REJECT", notes: "checked" })).rejects.toMatchObject({ code: "FORBIDDEN", message: "CREATOR_WORKSPACE_OWNER_REQUIRED" });
    await expect(caller(502).creator.review.finalizeMaster(base)).rejects.toMatchObject({ code: "FORBIDDEN", message: "CREATOR_WORKSPACE_OWNER_REQUIRED" });
    expect(await counts(assetId)).toEqual(before);
  });

  it("denies a cross-tenant / non-member user on all four mutations, with no side effects", async () => {
    const assetId = await freshMaster("cross-tenant-denied");
    const before = await counts(assetId);
    const base = { workspaceId: 7, creatorProjectId: ids.project, assetId };
    await expect(caller(999).creator.review.quality({ ...base, reviewerType: "HUMAN", sourcePromptOrStoryboard: "x", dimensionScores: dims, criticalDefects: [] })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller(999).creator.review.humanTamil({ ...base, decision: "PASS", notes: "x" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller(999).creator.review.humanVisual({ ...base, decision: "PASS", notes: "x" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller(999).creator.review.finalizeMaster(base)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await counts(assetId)).toEqual(before);
  });

  it("the owner-authorized flow still works end to end: quality -> Tamil -> visual -> finalize", async () => {
    const assetId = await freshMaster("owner-flow");
    const base = { workspaceId: 7, creatorProjectId: ids.project, assetId };
    const quality = await caller(501).creator.review.quality({ ...base, reviewerType: "HUMAN", sourcePromptOrStoryboard: "approved storyboard and shot prompts", dimensionScores: dims, criticalDefects: [] });
    expect(quality.decision).toBe("PASS");
    expect(quality.quality.outputConformance.actual).toEqual({ width: 1920, height: 1080, fps: 24, durationSeconds: 4, hasAudio: true });
    await expect(caller(501).creator.review.humanTamil({ ...base, decision: "PASS", notes: "Tamil checked against approved text" })).resolves.toMatchObject({ decision: "PASS" });
    await expect(caller(501).creator.review.humanVisual({ ...base, decision: "PASS", notes: "visual checked" })).resolves.toMatchObject({ decision: "PASS" });
    const finalMaster = await caller(501).creator.review.finalizeMaster(base);
    expect(finalMaster).toMatchObject({ finalMaster: true, assetId });
    const after = await counts(assetId);
    expect(after).toEqual({ reviews: 3, reviewDecision: "APPROVED" });
  });

  it("rejects absent, malformed or forged FFprobe evidence before recording quality approval", async () => {
    const examples = [
      { label: "no-evidence", evidence: null, code: "CREATOR_QUALITY_OUTPUT_EVIDENCE_REQUIRED" },
      { label: "malformed-evidence", evidence: { width: "1920", height: 1080, fps: 24, durationSeconds: 4, hasAudio: true }, code: "CREATOR_QUALITY_OUTPUT_EVIDENCE_INVALID" },
      { label: "wrong-width-evidence", evidence: { width: 1280, height: 1080, fps: 24, durationSeconds: 4, hasAudio: true }, code: "CREATOR_QUALITY_OUTPUT_EVIDENCE_DRIFT" },
      { label: "no-audio-evidence", evidence: { width: 1920, height: 1080, fps: 24, durationSeconds: 4, hasAudio: false }, code: "CREATOR_QUALITY_OUTPUT_NONCONFORMANT:audio" },
    ];
    for (const item of examples) {
      const assetId = await freshMaster(item.label, item.evidence);
      await expect(caller(501).creator.review.quality({
        workspaceId: 7, creatorProjectId: ids.project, assetId,
        reviewerType: "HUMAN", sourcePromptOrStoryboard: "approved storyboard",
        dimensionScores: dims, criticalDefects: [],
      })).rejects.toMatchObject({ message: item.code });
      expect(await counts(assetId)).toEqual({ reviews: 0, reviewDecision: "PENDING" });
    }
  });


  it("fails closed before recording quality if the candidate storage checksum cannot be verified", async () => {
    const assetId = await freshMaster("storage-corrupt");
    holder.verify.mockRejectedValueOnce(new Error("simulated S3 checksum mismatch"));
    await expect(caller(501).creator.review.quality({
      workspaceId: 7, creatorProjectId: ids.project, assetId,
      reviewerType: "HUMAN", sourcePromptOrStoryboard: "synthetic storyboard",
      dimensionScores: dims, criticalDefects: [],
    })).rejects.toMatchObject({ message: "CREATOR_REVIEW_CANDIDATE_STORAGE_UNVERIFIED" });
    expect(await counts(assetId)).toEqual({ reviews: 0, reviewDecision: "PENDING" });
  });

  it("binds quality scores to the candidate bytes and rejects metadata substitution before human approval", async () => {
    const assetId = await freshMaster("candidate-drift");
    const base = { workspaceId: 7, creatorProjectId: ids.project, assetId };
    await caller(501).creator.review.quality({
      ...base, reviewerType: "HUMAN", sourcePromptOrStoryboard: "synthetic storyboard",
      dimensionScores: dims, criticalDefects: [],
    });
    const saved = await one<{ scoresJson: string }>(sql`SELECT scoresJson FROM creatorReviews WHERE assetId = ${assetId} AND reviewType = 'QUALITY'`);
    const bound = JSON.parse(saved.scoresJson).candidateArtifact;
    expect(bound).toMatchObject({ storageKey: "r/candidate-drift.mp4", byteSize: 1000 });
    await run(sql`UPDATE creatorAssets SET checksumSha256 = ${"b".repeat(64)} WHERE id = ${assetId}`);
    await expect(caller(501).creator.review.humanTamil({ ...base, decision: "PASS", notes: "reviewed Tamil" }))
      .rejects.toMatchObject({ message: "CREATOR_REVIEW_CANDIDATE_IDENTITY_DRIFT" });
    expect(await counts(assetId)).toEqual({ reviews: 1, reviewDecision: "PENDING" });
  });

  it("re-verifies the exact stored candidate before final-master promotion", async () => {
    const assetId = await freshMaster("final-readback");
    const base = { workspaceId: 7, creatorProjectId: ids.project, assetId };
    await caller(501).creator.review.quality({
      ...base, reviewerType: "HUMAN", sourcePromptOrStoryboard: "synthetic storyboard",
      dimensionScores: dims, criticalDefects: [],
    });
    await caller(501).creator.review.humanTamil({ ...base, decision: "PASS", notes: "Tamil reviewed" });
    await caller(501).creator.review.humanVisual({ ...base, decision: "PASS", notes: "visual reviewed" });
    holder.verify.mockRejectedValueOnce(new Error("simulated missing object"));
    await expect(caller(501).creator.review.finalizeMaster(base))
      .rejects.toMatchObject({ message: "CREATOR_REVIEW_CANDIDATE_STORAGE_UNVERIFIED" });
    expect(await counts(assetId)).toEqual({ reviews: 3, reviewDecision: "PENDING" });
  });

  it("serializes two simultaneous quality decisions into exactly one durable review", async () => {
    const assetId = await freshMaster("parallel-quality");
    const base = { workspaceId: 7, creatorProjectId: ids.project, assetId };
    const payload = { ...base, reviewerType: "HUMAN" as const, sourcePromptOrStoryboard: "reviewed synthetic storyboard", dimensionScores: dims, criticalDefects: [] };
    const outcomes = await Promise.allSettled([
      caller(501).creator.review.quality(payload),
      caller(501).creator.review.quality(payload),
    ]);
    expect(outcomes.filter(outcome => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(outcome => outcome.status === "rejected")).toHaveLength(1);
    expect(await counts(assetId)).toEqual({ reviews: 1, reviewDecision: "PENDING" });
  });

  it("serializes simultaneous Tamil reviews and preserves the first immutable decision", async () => {
    const assetId = await freshMaster("parallel-tamil");
    const base = { workspaceId: 7, creatorProjectId: ids.project, assetId };
    await caller(501).creator.review.quality({
      ...base, reviewerType: "HUMAN", sourcePromptOrStoryboard: "approved synthetic storyboard",
      dimensionScores: dims, criticalDefects: [],
    });
    const outcomes = await Promise.allSettled([
      caller(501).creator.review.humanTamil({ ...base, decision: "PASS", notes: "Tamil text reviewed" }),
      caller(501).creator.review.humanTamil({ ...base, decision: "REJECT", notes: "Tamil text rejected" }),
    ]);
    expect(outcomes.filter(outcome => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(outcome => outcome.status === "rejected")).toHaveLength(1);
    const rows = (await run(sql`SELECT decision FROM creatorReviews WHERE assetId = ${assetId} AND reviewType = 'HUMAN_TAMIL'`)) as unknown as [{ decision: string }[]];
    expect(rows[0]).toHaveLength(1);
    const winner = outcomes.find(outcome => outcome.status === "fulfilled");
    if (!winner || winner.status !== "fulfilled") throw new Error("no Tamil winner");
    expect(rows[0][0].decision).toBe(winner.value.decision);
    expect(await counts(assetId)).toEqual({
      reviews: 2, reviewDecision: winner.value.decision === "REJECT" ? "REJECTED" : "PENDING",
    });
  });

  it("permits exactly one concurrent final-master promotion after all human approvals", async () => {
    const assetId = await freshMaster("parallel-final");
    const base = { workspaceId: 7, creatorProjectId: ids.project, assetId };
    await caller(501).creator.review.quality({
      ...base, reviewerType: "HUMAN", sourcePromptOrStoryboard: "approved synthetic storyboard",
      dimensionScores: dims, criticalDefects: [],
    });
    await caller(501).creator.review.humanTamil({ ...base, decision: "PASS", notes: "Tamil text reviewed" });
    await caller(501).creator.review.humanVisual({ ...base, decision: "PASS", notes: "visual playback reviewed" });
    const outcomes = await Promise.allSettled([
      caller(501).creator.review.finalizeMaster(base),
      caller(501).creator.review.finalizeMaster(base),
    ]);
    expect(outcomes.filter(outcome => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(outcome => outcome.status === "rejected")).toHaveLength(1);
    expect(await counts(assetId)).toEqual({ reviews: 3, reviewDecision: "APPROVED" });
  });

  it("blocks stale Tamil/visual/final decisions after a newer successful 16:9 export on the same timeline", async () => {
    const oldAssetId = await freshMaster("superseded-original");
    const old = { workspaceId: 7, creatorProjectId: ids.project, assetId: oldAssetId };
    await caller(501).creator.review.quality({
      ...old, reviewerType: "HUMAN", sourcePromptOrStoryboard: "synthetic original",
      dimensionScores: dims, criticalDefects: [],
    });
    await caller(501).creator.review.humanTamil({ ...old, decision: "PASS", notes: "Tamil reviewed on original" });

    const replacementAssetId = await freshMaster("superseded-replacement");
    await run(sql`INSERT INTO creatorExports
      (workspaceId, creatorProjectId, timelineId, assetId, status, width, height, format, renderer)
      VALUES (7, ${ids.project}, ${ids.timeline}, ${replacementAssetId}, 'SUCCEEDED', 1920, 1080, 'mp4', 'ffmpeg')`);

    await expect(caller(501).creator.review.humanVisual({
      ...old, decision: "PASS", notes: "stale original visual",
    })).rejects.toMatchObject({ message: "CREATOR_REVIEW_CANDIDATE_SUPERSEDED" });
    await expect(caller(501).creator.review.finalizeMaster(old))
      .rejects.toMatchObject({ message: "CREATOR_REVIEW_CANDIDATE_SUPERSEDED" });
    expect(await counts(oldAssetId)).toEqual({ reviews: 2, reviewDecision: "PENDING" });

    const replacement = { workspaceId: 7, creatorProjectId: ids.project, assetId: replacementAssetId };
    await expect(caller(501).creator.review.quality({
      ...replacement, reviewerType: "HUMAN", sourcePromptOrStoryboard: "replacement synthetic storyboard",
      dimensionScores: dims, criticalDefects: [],
    })).resolves.toMatchObject({ decision: "PASS" });
    expect(await counts(replacementAssetId)).toEqual({ reviews: 1, reviewDecision: "PENDING" });
  });

  it("a member can still read the project (getProject is unaffected)", async () => {
    await expect(caller(502).creator.workspace.getProject({ workspaceId: 7, creatorProjectId: ids.project })).resolves.toBeTruthy();
  });
});
