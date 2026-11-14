import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDatabase, skipMysqlSuite, type TestDatabase } from "../testing/mysqlTestDb";

/**
 * Database-backed acceptance for the previously disconnected Creator links:
 * generated visual PENDING -> owner review -> timeline eligibility -> locked
 * Tamil captions -> candidate -> quality gate. Media transport/FFmpeg are
 * deliberately mocked here; real FFmpeg/MinIO is tested in the sibling suite.
 * No synthetic media is presented as an approved Murugan master.
 */
const holder = vi.hoisted(() => ({
  db: undefined as unknown,
  verify: vi.fn(async (_key: string, _size: number, _sha: string) => undefined),
}));
vi.mock("../db", async original => ({
  ...(await original<typeof import("../db")>()),
  getDb: async () => holder.db,
  getWorkspaceForUser: async (userId: number, workspaceId: number) =>
    userId === 501 && workspaceId === 7 ? { id: 7 } : undefined,
  getWorkspaceRole: async (userId: number, workspaceId: number) =>
    userId === 501 && workspaceId === 7 ? "owner" : undefined,
}));
vi.mock("../storage", async original => ({
  ...(await original<typeof import("../storage")>()),
  storageVerifySha256: (...args: [string, number, string]) => holder.verify(...args),
}));

import { appRouter } from "../routers";
import type { TrpcContext } from "../_core/context";
import { replaceApprovedTimelineItems } from "./timeline";
import { executeCreatorTimelineExport } from "./renderService";
import { recordCreatorQualityReview, finalizeCreatorMaster } from "./reviewService";
import { loadCreatorQualityPolicy } from "./qualityGate";

const checksum = "a".repeat(64);
const fakeRenderedBytes = Buffer.from("synthetic-candidate-only");
function ownerCaller() {
  const now = new Date();
  return appRouter.createCaller({
    req: {} as TrpcContext["req"],
    res: { headersSent: false, setHeader: () => undefined } as unknown as TrpcContext["res"],
    requestId: "creator-murugan-p0-disposable-acceptance",
    user: { id: 501, openId: "murugan-p0-owner", name: "test", email: "test@example.invalid",
      loginMethod: "google", role: "user", createdAt: now, updatedAt: now, lastSignedIn: now },
  });
}

describe.skipIf(skipMysqlSuite())("Murugan Creator P0: owner review to candidate (disposable MySQL)", { timeout: 60_000 }, () => {
  let database: TestDatabase;
  let projectId: number;
  let timelineId: number;
  let audioId: number;
  const visualIds: number[] = [];
  const shotIds: number[] = [];
  const run = (statement: ReturnType<typeof sql>) => database.db.execute(statement);
  const one = async <T>(statement: ReturnType<typeof sql>) =>
    ((await run(statement)) as unknown as [T[]])[0][0] as T;

  beforeAll(async () => {
    database = await createTestDatabase();
    holder.db = database.db;
    await run(sql`INSERT INTO creatorProjects (workspaceId, name) VALUES (7, 'murugan-p0-synthetic-acceptance')`);
    projectId = (await one<{ id: number }>(sql`SELECT id FROM creatorProjects WHERE name = 'murugan-p0-synthetic-acceptance'`)).id;
    await run(sql`INSERT INTO creatorScenes (workspaceId, creatorProjectId, sceneIndex, title)
      VALUES (7, ${projectId}, 0, 'Synthetic storyboard scene')`);
    const sceneId = (await one<{ id: number }>(sql`SELECT id FROM creatorScenes WHERE creatorProjectId = ${projectId}`)).id;
    await run(sql`INSERT INTO creatorAssets (workspaceId, creatorProjectId, assetType, mimeType, storageKey,
      checksumSha256, byteSize, immutable, provenanceJson, reviewDecision)
      VALUES (7, ${projectId}, 'AUDIO_MASTER', 'audio/wav', ${`creator/7/${projectId}/audio-test.wav`},
      ${checksum}, 100, 1, '{"durationMs":2000}', 'APPROVED')`);
    audioId = (await one<{ id: number }>(sql`SELECT id FROM creatorAssets WHERE assetType = 'AUDIO_MASTER' AND creatorProjectId = ${projectId}`)).id;
    await run(sql`INSERT INTO creatorTimelines (workspaceId, creatorProjectId, name, audioMasterAssetId, width, height, fps)
      VALUES (7, ${projectId}, 'Master 16:9', ${audioId}, 1920, 1080, 24)`);
    timelineId = (await one<{ id: number }>(sql`SELECT id FROM creatorTimelines WHERE creatorProjectId = ${projectId}`)).id;
    await run(sql`INSERT INTO creatorCaptionCues (workspaceId, creatorProjectId, timelineId, startMs, endMs, text, language, locked)
      VALUES (7, ${projectId}, ${timelineId}, 0, 1000, 'வேல் முருகா', 'ta', 1),
        (7, ${projectId}, ${timelineId}, 1000, 2000, 'அரோகரா', 'ta', 1)`);

    for (let i = 0; i < 2; i++) {
      await run(sql`INSERT INTO creatorShots (workspaceId, creatorProjectId, sceneId, shotIndex, title)
        VALUES (7, ${projectId}, ${sceneId}, ${i + 1}, ${`Synthetic shot ${i + 1}`})`);
      const shotId = (await one<{ id: number }>(sql`SELECT MAX(id) AS id FROM creatorShots WHERE creatorProjectId = ${projectId}`)).id;
      shotIds.push(shotId);
      await run(sql`INSERT INTO creatorGenerations (workspaceId, creatorProjectId, shotId, kind, provider, model, parametersJson, status)
        VALUES (7, ${projectId}, ${shotId}, 'IMAGE', 'google', 'synthetic-test', '{}', 'SUCCEEDED')`);
      const generationId = (await one<{ id: number }>(sql`SELECT MAX(id) AS id FROM creatorGenerations WHERE creatorProjectId = ${projectId}`)).id;
      const providerJobId = `synthetic-job-${generationId}`;
      await run(sql`INSERT INTO creatorProviderJobs (workspaceId, creatorProjectId, generationId, provider, providerJobId, status)
        VALUES (7, ${projectId}, ${generationId}, 'google', ${providerJobId}, 'SUCCEEDED')`);
      const provenance = JSON.stringify({ schemaVersion: 1, creatorProjectId: projectId, shotId,
        generationId, provider: "google", providerJobId, checksumSha256: checksum });
      await run(sql`INSERT INTO creatorAssets (workspaceId, creatorProjectId, shotId, assetType, mimeType, storageKey,
        checksumSha256, byteSize, immutable, provenanceJson, reviewDecision)
        VALUES (7, ${projectId}, ${shotId}, 'IMAGE', 'image/png',
          ${`creator/7/${projectId}/synthetic-${generationId}.png`}, ${checksum}, 100, 1, ${provenance}, 'PENDING')`);
      const assetId = (await one<{ id: number }>(sql`SELECT MAX(id) AS id FROM creatorAssets WHERE creatorProjectId = ${projectId}`)).id;
      visualIds.push(assetId);
      await run(sql`UPDATE creatorGenerations SET outputAssetId = ${assetId} WHERE id = ${generationId}`);
    }
  });
  afterAll(async () => { holder.db = undefined; await database?.close(); });

  it("requires owner decisions for BOTH shots, renders a review-pending 16:9 candidate, and blocks final approval", async () => {
    const timeline = {
      workspaceId: 7, creatorProjectId: projectId, timelineId,
      items: visualIds.map((assetId, index) => ({ assetId, shotId: shotIds[index],
        startMs: index * 1000, endMs: (index + 1) * 1000 })),
    };
    await expect(replaceApprovedTimelineItems(timeline)).rejects.toThrow("CREATOR_TIMELINE_ASSET_NOT_APPROVED");
    for (const assetId of visualIds) {
      await expect(ownerCaller().creator.review.reviewGeneratedAsset({
        workspaceId: 7, creatorProjectId: projectId, assetId, expectedChecksumSha256: checksum,
        decision: "APPROVE", notes: "Reviewed synthetic test visual", confirmAssetReviewed: true,
      })).resolves.toMatchObject({ reviewDecision: "APPROVED", timelineEligible: true, publishApproved: false });
    }
    expect(holder.verify).toHaveBeenCalledTimes(2);
    await expect(replaceApprovedTimelineItems(timeline)).resolves.toMatchObject({ completeCoverage: true, itemCount: 2, durationMs: 2000 });

    const candidate = await executeCreatorTimelineExport(
      { workspaceId: 7, creatorProjectId: projectId, timelineId },
      {
        getSignedUrl: async key => `https://synthetic.invalid/${key}`,
        createTempDir: async () => "/tmp/creator-murugan-synthetic",
        cleanupTempDir: async () => undefined,
        writeSubtitle: async (_path, content) => {
          expect(content).toContain("வேல் முருகா");
          expect(content).toContain("அரோகரா");
        },
        executeFfmpeg: async args => {
          expect(args.join(" ")).toContain("1920:1080");
          return { exitCode: 0, stderr: "" };
        },
        readOutput: async () => fakeRenderedBytes,
        probeOutput: async () => ({ width: 1920, height: 1080, fps: 24, durationSeconds: 2, hasAudio: true }),
        putArtifact: async key => ({ key, url: "/api/storage/synthetic-candidate" }),
        verifyArtifact: async (_key, size, sha) => {
          expect(size).toBe(fakeRenderedBytes.length);
          expect(sha).toBe(createHash("sha256").update(fakeRenderedBytes).digest("hex"));
        },
        captionFonts: { dir: "/test-fonts", family: "Noto Sans Tamil" },
      },
    );
    expect(candidate).toMatchObject({ reviewDecision: "PENDING", width: 1920, height: 1080, fps: 24 });
    const { spec } = loadCreatorQualityPolicy();
    const zeroScores = Object.fromEntries(spec.sakthiaiAcceptanceDimensions.map(item => [item.id, 0]));
    const quality = await recordCreatorQualityReview({
      workspaceId: 7, creatorProjectId: projectId, assetId: candidate.assetId,
      reviewerUserId: 501, reviewerType: "ASSISTED_HUMAN", sourcePromptOrStoryboard: "synthetic storyboard",
      dimensionScores: zeroScores, criticalDefects: [], notes: "Technical render only; human evaluation pending",
    });
    expect(quality.decision).toBe("REGENERATE");
    expect(quality.finalMaster).toBe(false);
    await expect(finalizeCreatorMaster({ workspaceId: 7, creatorProjectId: projectId, assetId: candidate.assetId }))
      .rejects.toThrow("CREATOR_FINAL_MASTER_QUALITY_PASS_REQUIRED");
    const saved = await one<{ reviewDecision: string }>(sql`SELECT reviewDecision FROM creatorAssets WHERE id = ${candidate.assetId}`);
    expect(saved.reviewDecision).toBe("PENDING");
  });
});
