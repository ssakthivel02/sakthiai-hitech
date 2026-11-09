import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { createTestDatabase, skipMysqlSuite, type TestDatabase } from "../testing/mysqlTestDb";

const holder = vi.hoisted(() => ({ db: undefined as unknown, roles: new Map<number, "owner" | "member">() }));
vi.mock("../db", async importOriginal => ({
  ...(await importOriginal<typeof import("../db")>()),
  getDb: async () => holder.db,
  getWorkspaceForUser: async (userId: number, workspaceId: number) => (workspaceId === 7 && holder.roles.has(userId) ? { id: 7 } : undefined),
  getWorkspaceRole: async (userId: number, workspaceId: number) => (workspaceId === 7 ? holder.roles.get(userId) : undefined),
}));

import { executeCreatorTimelineExport } from "./renderService";
import { getCreatorExportManifest } from "./exportManifest";
import { reviewVerticalDerivative } from "./derivativeReview";
import { appRouter } from "../routers";
import type { TrpcContext } from "../_core/context";

function caller(userId: number) {
  const now = new Date();
  return appRouter.createCaller({
    req: {} as TrpcContext["req"], res: { headersSent: false, setHeader: () => undefined } as unknown as TrpcContext["res"], requestId: "crop-review",
    user: { id: userId, openId: `u${userId}`, name: "u", email: "u@example.invalid", loginMethod: "google", role: "user", createdAt: now, updatedAt: now, lastSignedIn: now },
  });
}

/** Real SQL: 9:16 derivative export through the real export service (ffmpeg + storage faked) and its manifest. */
describe.skipIf(skipMysqlSuite())("9:16 delivery derivative and export manifest (real SQL)", { timeout: 60_000 }, () => {
  let database: TestDatabase;
  const run = (s: ReturnType<typeof sql>) => database.db.execute(s);
  const one = async <T>(s: ReturnType<typeof sql>) => ((await database.db.execute(s)) as unknown as [T[]])[0][0];
  const ids: Record<string, number> = {};
  const ffmpegArgs: string[][] = [];
  const deps = {
    getSignedUrl: async (key: string) => `https://signed.example/${key}`,
    createTempDir: async () => "/tmp/vertical-test",
    cleanupTempDir: async () => undefined,
    writeSubtitle: async () => undefined,
    readOutput: async () => Buffer.from("fake-mp4-output"),
    executeFfmpeg: async (args: string[]) => { ffmpegArgs.push(args); return { exitCode: 0, stderr: "" }; },
    putArtifact: async (key: string) => ({ key, url: `/api/storage/${key}` }),
    verifyArtifact: async (_key: string, expectedSize: number, expectedSha256: string) => {
      const stored = Buffer.from("fake-mp4-output");
      expect(expectedSize).toBe(stored.byteLength);
      expect(expectedSha256).toBe(createHash("sha256").update(stored).digest("hex"));
    },
    captionFonts: { dir: "/fonts", family: "Noto Sans Tamil" },
  };

  beforeAll(async () => {
    database = await createTestDatabase();
    holder.db = database.db;
    await run(sql`INSERT INTO creatorProjects (workspaceId, name) VALUES (7, 'vertical')`);
    ids.project = (await one<{ id: number }>(sql`SELECT id FROM creatorProjects WHERE name = 'vertical'`)).id;
    await run(sql`INSERT INTO creatorAssets (workspaceId, creatorProjectId, assetType, mimeType, storageKey, checksumSha256, byteSize, immutable, provenanceJson, reviewDecision) VALUES
      (7, ${ids.project}, 'AUDIO_MASTER', 'audio/wav', 'a/master.wav', ${"a".repeat(64)}, 10, 1, '{"durationMs":4000}', 'APPROVED'),
      (7, ${ids.project}, 'IMAGE', 'image/png', 'v/one.png', ${"1".repeat(64)}, 10, 1, '{}', 'APPROVED'),
      (7, ${ids.project}, 'VIDEO', 'video/mp4', 'v/two.mp4', ${"2".repeat(64)}, 10, 0, '{"generationId":0}', 'APPROVED')`);
    for (const [k, key] of [["audio", "a/master.wav"], ["v1", "v/one.png"], ["v2", "v/two.mp4"]] as const) ids[k] = (await one<{ id: number }>(sql`SELECT id FROM creatorAssets WHERE storageKey = ${key}`)).id;
    await run(sql`INSERT INTO creatorTimelines (workspaceId, creatorProjectId, name, audioMasterAssetId, width, height, fps) VALUES (7, ${ids.project}, 'main', ${ids.audio}, 1920, 1080, 24)`);
    ids.timeline = (await one<{ id: number }>(sql`SELECT id FROM creatorTimelines WHERE creatorProjectId = ${ids.project}`)).id;
    await run(sql`INSERT INTO creatorTimelineItems (workspaceId, creatorProjectId, timelineId, assetId, startMs, endMs, track, sortOrder) VALUES
      (7, ${ids.project}, ${ids.timeline}, ${ids.v1}, 0, 2000, 1, 0), (7, ${ids.project}, ${ids.timeline}, ${ids.v2}, 2000, 4000, 1, 1)`);
    await run(sql`INSERT INTO creatorCaptionCues (workspaceId, creatorProjectId, timelineId, startMs, endMs, text, language, locked) VALUES (7, ${ids.project}, ${ids.timeline}, 0, 1500, 'முருகா', 'ta', 1)`);
  });
  afterAll(async () => { await database?.close(); });

  it("a 16:9 master candidate cannot be the source of a derivative until it is the approved final master", async () => {
    const master = await executeCreatorTimelineExport({ workspaceId: 7, creatorProjectId: ids.project, timelineId: ids.timeline }, deps);
    ids.master = master.assetId;
    expect(master).toMatchObject({ width: 1920, height: 1080, reviewDecision: "PENDING" });
    await expect(executeCreatorTimelineExport({ workspaceId: 7, creatorProjectId: ids.project, timelineId: ids.timeline, verticalDerivativeOf: ids.master }, deps)).rejects.toThrow("CREATOR_DERIVATIVE_MASTER_NOT_FINAL");
    await expect(executeCreatorTimelineExport({ workspaceId: 8, creatorProjectId: ids.project, timelineId: ids.timeline, verticalDerivativeOf: ids.master }, deps)).rejects.toThrow("CREATOR_RENDER_TIMELINE_NOT_FOUND");
  });

  it("renders a 1080×1920 cover-fit derivative of the final master, recorded as a non-promotable derivative", async () => {
    await run(sql`UPDATE creatorAssets SET reviewDecision = 'APPROVED' WHERE id = ${ids.master}`);
    const derivative = await executeCreatorTimelineExport({ workspaceId: 7, creatorProjectId: ids.project, timelineId: ids.timeline, verticalDerivativeOf: ids.master }, deps);
    expect(derivative).toMatchObject({ width: 1080, height: 1920, reviewDecision: "PENDING" });
    expect(ffmpegArgs.at(-1)!.join(" ")).toContain("force_original_aspect_ratio=increase,crop=1080:1920");
    const exp = await one<{ width: number; height: number; parametersJson: string }>(sql`SELECT width, height, parametersJson FROM creatorExports WHERE id = ${derivative.exportId}`);
    expect(exp).toMatchObject({ width: 1080, height: 1920 });
    expect(JSON.parse(exp.parametersJson)).toMatchObject({ aspectRatio: "9:16", fit: "cover", derivativeOfRenderAssetId: ids.master });
    const asset = await one<{ provenanceJson: string }>(sql`SELECT provenanceJson FROM creatorAssets WHERE id = ${derivative.assetId}`);
    expect(JSON.parse(asset.provenanceJson)).toMatchObject({ source: "deterministic-creator-derivative", derivativeOfRenderAssetId: ids.master, aspectRatio: "9:16" });

    const manifest = await getCreatorExportManifest({ workspaceId: 7, creatorProjectId: ids.project, exportId: derivative.exportId });
    expect(manifest.output).toMatchObject({ kind: "DELIVERY_DERIVATIVE", finalMaster: false, derivativeOf: { renderAssetId: ids.master } });
    expect(manifest.visuals.map(v => v.assetId)).toEqual([ids.v1, ids.v2]);
    expect(manifest.audioMaster).toMatchObject({ assetId: ids.audio, checksumSha256: "a".repeat(64) });
    expect(manifest.captions).toMatchObject({ count: 1, locked: true, languages: ["ta"] });
    expect(JSON.stringify(manifest)).not.toMatch(/storageKey|v\/one\.png|signed\.example/);
    await expect(getCreatorExportManifest({ workspaceId: 8, creatorProjectId: ids.project, exportId: derivative.exportId })).rejects.toThrow("CREATOR_EXPORT_NOT_FOUND");

    // Crop review: the master cannot be reviewed through this route; concurrent crop decisions cannot both win.
    const review = (assetId: number, decision: "PASS" | "REJECT", workspaceId = 7) =>
      reviewVerticalDerivative({ workspaceId, creatorProjectId: ids.project, assetId, reviewerUserId: 1, decision, notes: "Vel, face and captions fully in frame." });
    await expect(review(ids.master, "PASS")).rejects.toThrow("CREATOR_DERIVATIVE_REVIEW_NOT_FOUND");
    await expect(review(derivative.assetId, "PASS", 8)).rejects.toThrow("CREATOR_DERIVATIVE_REVIEW_NOT_FOUND");
    await expect(reviewVerticalDerivative({ workspaceId: 7, creatorProjectId: ids.project, assetId: derivative.assetId, reviewerUserId: 1, decision: "PASS", notes: " " })).rejects.toThrow("CREATOR_HUMAN_REVIEW_NOTES_REQUIRED");
    const outcomes = await Promise.allSettled([review(derivative.assetId, "PASS"), review(derivative.assetId, "REJECT")]);
    expect(outcomes.filter(o => o.status === "fulfilled")).toHaveLength(1);
    expect((outcomes.find(o => o.status === "rejected") as PromiseRejectedResult).reason.message).toBe("CREATOR_DERIVATIVE_REVIEW_ALREADY_FINAL");
    const winner = (outcomes.find(o => o.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof reviewVerticalDerivative>>>).value;
    const reviews = await one<{ n: number }>(sql`SELECT COUNT(*) AS n FROM creatorReviews WHERE assetId = ${derivative.assetId} AND reviewType = 'HUMAN_VISUAL'`);
    expect(Number(reviews.n)).toBe(1);
    const after = await getCreatorExportManifest({ workspaceId: 7, creatorProjectId: ids.project, exportId: derivative.exportId });
    expect(after.output).toMatchObject({ deliveryApproved: winner.decision === "PASS", finalMaster: false });
    const masterRow = await one<{ reviewDecision: string }>(sql`SELECT reviewDecision FROM creatorAssets WHERE id = ${ids.master}`);
    expect(masterRow.reviewDecision).toBe("APPROVED"); // the master is untouched
  });

  it("through the real router, a workspace member who is not the owner cannot PASS or REJECT a crop; nothing changes", async () => {
    holder.roles.set(501, "owner");
    holder.roles.set(502, "member");
    const derivative = await executeCreatorTimelineExport({ workspaceId: 7, creatorProjectId: ids.project, timelineId: ids.timeline, verticalDerivativeOf: ids.master }, deps);
    const input = (decision: "PASS" | "REJECT") => ({ workspaceId: 7, creatorProjectId: ids.project, assetId: derivative.assetId, decision, notes: "crop ok" });
    for (const decision of ["PASS", "REJECT"] as const) {
      await expect(caller(502).creator.timeline.reviewVerticalDerivative(input(decision))).rejects.toMatchObject({ code: "FORBIDDEN", message: "CREATOR_WORKSPACE_OWNER_REQUIRED" });
    }
    await expect(caller(999).creator.timeline.reviewVerticalDerivative(input("PASS"))).rejects.toMatchObject({ code: "FORBIDDEN" });
    const unchanged = await one<{ reviewDecision: string }>(sql`SELECT reviewDecision FROM creatorAssets WHERE id = ${derivative.assetId}`);
    expect(unchanged.reviewDecision).toBe("PENDING");
    const none = await one<{ n: number }>(sql`SELECT COUNT(*) AS n FROM creatorReviews WHERE assetId = ${derivative.assetId}`);
    expect(Number(none.n)).toBe(0);
    await expect(caller(501).creator.timeline.reviewVerticalDerivative(input("PASS"))).resolves.toMatchObject({ decision: "PASS", deliveryApproved: true });
    const after = await one<{ reviewDecision: string }>(sql`SELECT reviewDecision FROM creatorAssets WHERE id = ${derivative.assetId}`);
    expect(after.reviewDecision).toBe("APPROVED");
  });

  it("refuses a derivative once the timeline no longer matches the approved master", async () => {
    await run(sql`UPDATE creatorTimelineItems SET sortOrder = 0, startMs = 0, endMs = 4000 WHERE assetId = ${ids.v1}`);
    await run(sql`DELETE FROM creatorTimelineItems WHERE assetId = ${ids.v2}`);
    await expect(executeCreatorTimelineExport({ workspaceId: 7, creatorProjectId: ids.project, timelineId: ids.timeline, verticalDerivativeOf: ids.master }, deps)).rejects.toThrow("CREATOR_DERIVATIVE_SOURCE_DRIFT");
  });
});
