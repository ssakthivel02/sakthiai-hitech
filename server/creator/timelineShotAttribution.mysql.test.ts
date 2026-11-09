import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { createTestDatabase, skipMysqlSuite, type TestDatabase } from "../testing/mysqlTestDb";

/**
 * Exercises the actual tenant/project-scoped SQL and production Creator services.
 * Only the existing safe disposable MySQL fixture is used. FFmpeg and signed URLs
 * are mocked; no remote storage, generation, provider charge or live DB is touched.
 */
const holder = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("../db", async importOriginal => ({
  ...(await importOriginal<typeof import("../db")>()),
  getDb: async () => holder.db,
}));

import { replaceApprovedTimelineItems } from "./timeline";
import { executeCreatorTimelineExport } from "./renderService";

describe.skipIf(skipMysqlSuite())("Creator shot attribution: real MySQL tenant boundary", { timeout: 60_000 }, () => {
  let database: TestDatabase;
  const ids: Record<string, number> = {};
  const execute = (statement: ReturnType<typeof sql>) => database.db.execute(statement);
  const first = async <T>(statement: ReturnType<typeof sql>): Promise<T> => {
    const [rows] = await execute(statement) as unknown as [T[]];
    if (!rows[0]) throw new Error("TEST_FIXTURE_ROW_MISSING");
    return rows[0];
  };

  const input = (assetId: number, shotId?: number) => ({
    workspaceId: 7,
    creatorProjectId: ids.ownerProject,
    timelineId: ids.timeline,
    items: [{ assetId, shotId, startMs: 0, endMs: 4000, sortOrder: 0 }],
  });
  const countItems = async () => {
    const value = await first<{ n: number }>(sql`SELECT COUNT(*) AS n FROM creatorTimelineItems WHERE timelineId = ${ids.timeline}`);
    return Number(value.n);
  };
  const countExports = async () => {
    const value = await first<{ n: number }>(sql`SELECT COUNT(*) AS n FROM creatorExports WHERE timelineId = ${ids.timeline}`);
    return Number(value.n);
  };

  beforeAll(async () => {
    database = await createTestDatabase();
    holder.db = database.db;
    await execute(sql`INSERT INTO creatorProjects (workspaceId, name) VALUES
      (7, 'owner-shot-project'), (7, 'foreign-project-same-workspace'), (8, 'foreign-workspace-project')`);
    ids.ownerProject = (await first<{ id: number }>(sql`SELECT id FROM creatorProjects WHERE name = 'owner-shot-project'`)).id;
    ids.foreignProject = (await first<{ id: number }>(sql`SELECT id FROM creatorProjects WHERE name = 'foreign-project-same-workspace'`)).id;
    ids.foreignWorkspaceProject = (await first<{ id: number }>(sql`SELECT id FROM creatorProjects WHERE name = 'foreign-workspace-project'`)).id;
    await execute(sql`INSERT INTO creatorScenes (workspaceId, creatorProjectId, sceneIndex, title)
      VALUES (7, ${ids.ownerProject}, 0, 'owner'), (7, ${ids.foreignProject}, 0, 'other project'),
        (8, ${ids.foreignWorkspaceProject}, 0, 'other workspace')`);
    ids.ownerScene = (await first<{ id: number }>(sql`SELECT id FROM creatorScenes WHERE creatorProjectId = ${ids.ownerProject}`)).id;
    ids.foreignScene = (await first<{ id: number }>(sql`SELECT id FROM creatorScenes WHERE creatorProjectId = ${ids.foreignProject}`)).id;
    ids.foreignWorkspaceScene = (await first<{ id: number }>(sql`SELECT id FROM creatorScenes WHERE creatorProjectId = ${ids.foreignWorkspaceProject}`)).id;
    await execute(sql`INSERT INTO creatorShots (workspaceId, creatorProjectId, sceneId, shotIndex, title)
      VALUES (7, ${ids.ownerProject}, ${ids.ownerScene}, 1, 'owner shot A'),
        (7, ${ids.ownerProject}, ${ids.ownerScene}, 2, 'owner shot B'),
        (7, ${ids.foreignProject}, ${ids.foreignScene}, 1, 'other project shot'),
        (8, ${ids.foreignWorkspaceProject}, ${ids.foreignWorkspaceScene}, 1, 'other workspace shot')`);
    ids.shotA = (await first<{ id: number }>(sql`SELECT id FROM creatorShots WHERE title = 'owner shot A'`)).id;
    ids.shotB = (await first<{ id: number }>(sql`SELECT id FROM creatorShots WHERE title = 'owner shot B'`)).id;
    ids.foreignShot = (await first<{ id: number }>(sql`SELECT id FROM creatorShots WHERE title = 'other project shot'`)).id;
    ids.foreignWorkspaceShot = (await first<{ id: number }>(sql`SELECT id FROM creatorShots WHERE title = 'other workspace shot'`)).id;
    await execute(sql`INSERT INTO creatorAssets
      (workspaceId, creatorProjectId, assetType, mimeType, storageKey, checksumSha256, byteSize, immutable, provenanceJson, reviewDecision, shotId)
      VALUES (7, ${ids.ownerProject}, 'AUDIO_MASTER', 'audio/wav', 'fixture/audio.wav', ${"a".repeat(64)}, 10, 1, '{"durationMs":4000}', 'APPROVED', NULL),
        (7, ${ids.ownerProject}, 'VIDEO', 'video/mp4', 'fixture/montage.mp4', ${"b".repeat(64)}, 10, 1, '{}', 'APPROVED', NULL),
        (7, ${ids.ownerProject}, 'VIDEO', 'video/mp4', 'fixture/bound.mp4', ${"c".repeat(64)}, 10, 1, '{}', 'APPROVED', ${ids.shotA})`);
    ids.audio = (await first<{ id: number }>(sql`SELECT id FROM creatorAssets WHERE storageKey = 'fixture/audio.wav'`)).id;
    ids.montage = (await first<{ id: number }>(sql`SELECT id FROM creatorAssets WHERE storageKey = 'fixture/montage.mp4'`)).id;
    ids.bound = (await first<{ id: number }>(sql`SELECT id FROM creatorAssets WHERE storageKey = 'fixture/bound.mp4'`)).id;
    await execute(sql`INSERT INTO creatorTimelines
      (workspaceId, creatorProjectId, name, audioMasterAssetId, width, height, fps)
      VALUES (7, ${ids.ownerProject}, 'main', ${ids.audio}, 1920, 1080, 24)`);
    ids.timeline = (await first<{ id: number }>(sql`SELECT id FROM creatorTimelines WHERE creatorProjectId = ${ids.ownerProject}`)).id;
    await execute(sql`INSERT INTO creatorCaptionCues
      (workspaceId, creatorProjectId, timelineId, startMs, endMs, text, language, locked)
      VALUES (7, ${ids.ownerProject}, ${ids.timeline}, 0, 4000, 'வேல் முருகா', 'ta', 1)`);
  });
  afterAll(async () => { holder.db = undefined; await database?.close(); });
  beforeEach(async () => {
    await execute(sql`DELETE FROM creatorExports WHERE timelineId = ${ids.timeline}`);
    await execute(sql`DELETE FROM creatorTimelineItems WHERE timelineId = ${ids.timeline}`);
    await execute(sql`DELETE FROM creatorAssets WHERE creatorProjectId = ${ids.ownerProject} AND assetType = 'RENDER'`);
  });

  it("saves a legitimate same-project shot and an unbound montage asset", async () => {
    const result = await replaceApprovedTimelineItems(input(ids.montage, ids.shotA));
    expect(result).toMatchObject({ completeCoverage: true, itemCount: 1, durationMs: 4000 });
    const stored = await first<{ shotId: number; assetId: number }>(
      sql`SELECT shotId, assetId FROM creatorTimelineItems WHERE timelineId = ${ids.timeline}`,
    );
    expect(stored).toMatchObject({ shotId: ids.shotA, assetId: ids.montage });
  });

  it("rejects a different project in the same workspace before modifying the existing timeline", async () => {
    await replaceApprovedTimelineItems(input(ids.montage, ids.shotA));
    await expect(replaceApprovedTimelineItems(input(ids.montage, ids.foreignShot)))
      .rejects.toThrow("CREATOR_TIMELINE_SHOT_NOT_FOUND");
    expect(await countItems()).toBe(1);
    const stored = await first<{ shotId: number }>(sql`SELECT shotId FROM creatorTimelineItems WHERE timelineId = ${ids.timeline}`);
    expect(stored.shotId).toBe(ids.shotA);
  });

  it("rejects a different workspace and a local bound-asset shot mismatch without writing", async () => {
    await expect(replaceApprovedTimelineItems(input(ids.montage, ids.foreignWorkspaceShot)))
      .rejects.toThrow("CREATOR_TIMELINE_SHOT_NOT_FOUND");
    await expect(replaceApprovedTimelineItems(input(ids.bound, ids.shotB)))
      .rejects.toThrow("CREATOR_TIMELINE_SHOT_ASSET_MISMATCH");
    expect(await countItems()).toBe(0);
  });

  it("refuses legacy foreign-project shot rows BEFORE signing media or creating an export", async () => {
    const signedUrl = vi.fn(async (key: string) => "https://signed.invalid/" + key);
    const settings = { workspaceId: 7, creatorProjectId: ids.ownerProject, timelineId: ids.timeline };
    for (const foreignId of [ids.foreignShot, ids.foreignWorkspaceShot]) {
      await execute(sql`DELETE FROM creatorTimelineItems WHERE timelineId = ${ids.timeline}`);
      await execute(sql`INSERT INTO creatorTimelineItems
        (workspaceId, creatorProjectId, timelineId, assetId, shotId, track, startMs, endMs, sortOrder)
        VALUES (7, ${ids.ownerProject}, ${ids.timeline}, ${ids.montage}, ${foreignId}, 1, 0, 4000, 0)`);
      await expect(executeCreatorTimelineExport(settings, { getSignedUrl: signedUrl }))
        .rejects.toThrow("CREATOR_TIMELINE_SHOT_NOT_FOUND");
      expect(signedUrl).not.toHaveBeenCalled();
      expect(await countExports()).toBe(0);
    }
  });

  it("allows the valid stored shot through the existing FFmpeg integration using local mocked media only", async () => {
    await replaceApprovedTimelineItems(input(ids.montage, ids.shotA));
    const signedUrl = vi.fn(async (key: string) => "https://signed.invalid/" + key);
    const render = await executeCreatorTimelineExport(
      { workspaceId: 7, creatorProjectId: ids.ownerProject, timelineId: ids.timeline },
      {
        getSignedUrl: signedUrl,
        createTempDir: async () => "/tmp/creator-tenant-shot-test",
        cleanupTempDir: async () => undefined,
        writeSubtitle: async () => undefined,
        readOutput: async () => Buffer.from("synthetic-render"),
        executeFfmpeg: async () => ({ exitCode: 0, stderr: "" }),
        putArtifact: async key => ({ key, url: "/api/storage/synthetic" }),
        verifyArtifact: async (_key, expectedSize, expectedSha256) => {
          const stored = Buffer.from("synthetic-render");
          expect(expectedSize).toBe(stored.byteLength);
          expect(expectedSha256).toBe(createHash("sha256").update(stored).digest("hex"));
        },
        captionFonts: { dir: "/fonts", family: "Noto Sans Tamil" },
      },
    );
    expect(render).toMatchObject({ reviewDecision: "PENDING", width: 1920, height: 1080 });
    expect(signedUrl).toHaveBeenCalledTimes(2);
    expect(await countExports()).toBe(1);
    const provenance = await first<{ provenanceJson: string }>(
      sql`SELECT provenanceJson FROM creatorAssets WHERE id = ${render.assetId}`,
    );
    expect(JSON.parse(provenance.provenanceJson)).toMatchObject({
      source: "deterministic-creator-render",
      visualAssetIds: [ids.montage],
      audioMasterAssetId: ids.audio,
      timelineId: ids.timeline,
    });
  });
  it("serializes timeline replacement behind the render-intent timeline row lock", async () => {
    let release!: () => void;
    let signalLocked!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const locked = new Promise<void>(resolve => { signalLocked = resolve; });
    const reader = database.db.transaction(async tx => {
      await tx.execute(sql`SELECT id FROM creatorTimelines WHERE id = ${ids.timeline} FOR UPDATE`);
      signalLocked();
      await hold;
    });
    await locked;
    let writerSettled = false;
    const writer = replaceApprovedTimelineItems(input(ids.montage, ids.shotA))
      .finally(() => { writerSettled = true; });
    try {
      await new Promise(resolve => setTimeout(resolve, 150));
      expect(writerSettled).toBe(false);
      expect(await countItems()).toBe(0);
    } finally {
      release();
      await reader;
    }
    await writer;
    expect(await countItems()).toBe(1);
  });

});
