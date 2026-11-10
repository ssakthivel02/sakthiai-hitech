import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { createTestDatabase, skipMysqlSuite, type TestDatabase } from "../testing/mysqlTestDb";
import type { TrpcContext } from "../_core/context";
import type { CreatorRenderDispatchDependencies } from "./renderDispatch";

const holder = vi.hoisted(() => ({
  db: undefined as unknown,
  deps: undefined as unknown as CreatorRenderDispatchDependencies,
}));

vi.mock("../db", async importOriginal => ({
  ...(await importOriginal<typeof import("../db")>()),
  getDb: async () => holder.db,
}));
vi.mock("./paidGeneration", async importOriginal => ({
  ...(await importOriginal<typeof import("./paidGeneration")>()),
  // Route ownership is tested independently in fencedRenderRoute.test.ts.
  requireCreatorWorkspaceOwner: async () => undefined,
}));
vi.mock("./renderDispatch", async importOriginal => {
  const real = await importOriginal<typeof import("./renderDispatch")>();
  return {
    ...real,
    dispatchReservedCreatorRender: (
      input: Parameters<typeof real.dispatchReservedCreatorRender>[0],
      config: Parameters<typeof real.dispatchReservedCreatorRender>[1],
    ) => real.dispatchReservedCreatorRender(input, config, holder.deps),
  };
});

import { creatorTimelineRouter } from "./timelineRouter";
import { MysqlCreatorRenderClaims } from "./renderClaims";
import { readCreatorRenderIntentFromDatabase, reserveCreatorRenderIntentFromDatabase } from "./renderIntentDb";
import { resolveCreatorCaptionFonts } from "./renderWorker";

const hasMediaTools = spawnSync("ffmpeg", ["-version"]).status === 0 &&
  spawnSync("ffprobe", ["-version"]).status === 0;
if (process.env.MYSQL_REQUIRED === "1" && !hasMediaTools) {
  throw new Error("CREATOR_FENCED_REAL_MEDIA_CI_FFMPEG_FFPROBE_REQUIRED");
}
const digest = (data: Buffer) => createHash("sha256").update(data).digest("hex");

function caller() {
  const now = new Date();
  return creatorTimelineRouter.createCaller({
    req: {} as TrpcContext["req"],
    res: { headersSent: false, setHeader: () => undefined } as unknown as TrpcContext["res"],
    requestId: "creator-real-fenced-mysql",
    user: {
      id: 1, openId: "creator-fenced-test", name: "Creator test", email: "test@example.invalid",
      loginMethod: "google", role: "user" as const,
      createdAt: now, updatedAt: now, lastSignedIn: now,
    },
  });
}

/** Real disposable MySQL + actual FFmpeg/FFprobe + real route. Storage is an in-memory SHA-verified fixture. */
describe.skipIf(skipMysqlSuite() || !hasMediaTools)(
  "Creator fenced route real-media integration (disposable MySQL)", { timeout: 180_000 }, () => {
    let d: TestDatabase;
    let dir: string;
    let audioPath: string;
    let stillPath: string;
    const ids: Record<string, number> = {};
    const outputs = new Map<string, Buffer>();
    const exec = (s: ReturnType<typeof sql>) => d.db.execute(s);
    const first = async <T>(s: ReturnType<typeof sql>): Promise<T> => {
      const [rows] = await exec(s) as unknown as [T[]];
      if (!rows[0]) throw new Error("TEST_ROW_MISSING");
      return rows[0];
    };

    beforeAll(async () => {
      dir = mkdtempSync(join(tmpdir(), "creator-fenced-real-"));
      audioPath = join(dir, "approved-audio.wav");
      stillPath = join(dir, "approved-visual.bmp");
      execFileSync("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi",
        "-i", "sine=frequency=440:sample_rate=48000:duration=2",
        "-c:a", "pcm_s16le", audioPath,
      ], { timeout: 15_000 });
      execFileSync("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi",
        "-i", "color=c=blue:s=1920x1080:r=24", "-frames:v", "1", stillPath,
      ], { timeout: 15_000 });
      const audio = readFileSync(audioPath);
      const still = readFileSync(stillPath);

      d = await createTestDatabase();
      holder.db = d.db;
      await exec(sql`INSERT INTO creatorProjects (workspaceId, name) VALUES (7, 'fenced-real-media')`);
      ids.project = (await first<{ id: number }>(sql`SELECT id FROM creatorProjects WHERE name = 'fenced-real-media'`)).id;
      await exec(sql`INSERT INTO creatorScenes (workspaceId, creatorProjectId, sceneIndex, title)
        VALUES (7, ${ids.project}, 0, 'synthetic-acceptance')`);
      ids.scene = (await first<{ id: number }>(sql`SELECT id FROM creatorScenes WHERE creatorProjectId = ${ids.project}`)).id;
      await exec(sql`INSERT INTO creatorShots (workspaceId, creatorProjectId, sceneId, shotIndex, title)
        VALUES (7, ${ids.project}, ${ids.scene}, 0, 'synthetic-blue-frame')`);
      ids.shot = (await first<{ id: number }>(sql`SELECT id FROM creatorShots WHERE creatorProjectId = ${ids.project}`)).id;
      await exec(sql`INSERT INTO creatorAssets
        (workspaceId, creatorProjectId, shotId, assetType, mimeType, storageKey, checksumSha256,
         byteSize, immutable, provenanceJson, reviewDecision) VALUES
        (7, ${ids.project}, NULL, 'AUDIO_MASTER', 'audio/wav', 'fixture/audio.wav',
         ${digest(audio)}, ${audio.byteLength}, 1, '{"durationMs":2000}', 'APPROVED'),
        (7, ${ids.project}, ${ids.shot}, 'IMAGE', 'image/bmp', 'fixture/still.bmp',
         ${digest(still)}, ${still.byteLength}, 1, '{}', 'APPROVED')`);
      ids.audio = (await first<{ id: number }>(sql`SELECT id FROM creatorAssets WHERE storageKey = 'fixture/audio.wav'`)).id;
      ids.visual = (await first<{ id: number }>(sql`SELECT id FROM creatorAssets WHERE storageKey = 'fixture/still.bmp'`)).id;
      await exec(sql`INSERT INTO creatorTimelines
        (workspaceId, creatorProjectId, name, audioMasterAssetId, width, height, fps)
        VALUES (7, ${ids.project}, 'candidate', ${ids.audio}, 1920, 1080, 24)`);
      ids.timeline = (await first<{ id: number }>(sql`SELECT id FROM creatorTimelines WHERE creatorProjectId = ${ids.project}`)).id;
      await exec(sql`INSERT INTO creatorTimelineItems
        (workspaceId, creatorProjectId, timelineId, assetId, shotId, track, sortOrder, startMs, endMs)
        VALUES (7, ${ids.project}, ${ids.timeline}, ${ids.visual}, ${ids.shot}, 1, 0, 0, 2000)`);
      await exec(sql`INSERT INTO creatorCaptionCues
        (workspaceId, creatorProjectId, timelineId, startMs, endMs, text, language, locked)
        VALUES (7, ${ids.project}, ${ids.timeline}, 0, 2000, 'வேல் முருகா', 'ta', 1)`);

      const provider = async () => d.db;
      holder.deps = {
        reserve: (input, config, _dbProvider, leaseSeconds) =>
          reserveCreatorRenderIntentFromDatabase(input, config, provider, leaseSeconds),
        read: (input, config) => readCreatorRenderIntentFromDatabase(input, config, provider),
        claims: new MysqlCreatorRenderClaims(provider),
        leaseSeconds: 1800,
        heartbeatIntervalMs: 5000,
        resolveMedia: async intent => {
          // This local storage fixture verifies the real source bytes against DB-derived identities.
          if (intent.audioMaster.assetId !== ids.audio ||
              intent.audioMaster.checksumSha256 !== digest(readFileSync(audioPath)) ||
              intent.visuals.length !== 1 || intent.visuals[0].assetId !== ids.visual ||
              intent.visuals[0].checksumSha256 !== digest(readFileSync(stillPath))) {
            throw new Error("CREATOR_REAL_MEDIA_SOURCE_INTEGRITY_FAILED");
          }
          const visual = intent.visuals[0];
          return {
            audioSourceUrl: audioPath,
            visualItems: [{
              assetId: visual.assetId, shotId: visual.shotId, assetType: visual.assetType,
              sourceUrl: stillPath, startMs: visual.startMs, endMs: visual.endMs,
              track: visual.track, sortOrder: visual.sortOrder, approved: true,
            }],
          };
        },
        workerDependencies: {
          captionFonts: resolveCreatorCaptionFonts(),
          putArtifact: async (key, bytes) => {
            // Production storagePut appends eight lowercase hex characters.
            // Exercise the REAL returned object identity through the fenced
            // MySQL finalizer rather than the old unsuffixed test-only key.
            const storedKey = key.replace(/\\.mp4$/, "_a0b1c2d3.mp4");
            if (outputs.has(storedKey)) throw new Error("CREATOR_DUPLICATE_STORAGE_WRITE");
            outputs.set(storedKey, Buffer.from(bytes));
            return { key: storedKey, url: `memory://${storedKey}` };
          },
          verifyArtifact: async (key, size, sha) => {
            const stored = outputs.get(key);
            if (!stored || stored.byteLength !== size || digest(stored) !== sha) {
              throw new Error("CREATOR_REAL_MEDIA_STORAGE_READBACK_FAILED");
            }
          },
        },
      };
    }, 120_000);

    afterAll(async () => {
      await d?.close();
      if (dir) rmSync(dir, { recursive: true, force: true });
      vi.unstubAllEnvs();
    });

    it("renders once through the owner-only fenced route and preserves pending-review provenance", async () => {
      vi.stubEnv("CREATOR_FENCED_RENDER_ENABLED", "true");
      const input = { workspaceId: 7, creatorProjectId: ids.project, timelineId: ids.timeline, confirmCandidateOnly: true as const };
      const result = await caller().renderFencedCandidate(input);
      expect(result).toMatchObject({
        dispatched: true, reviewDecision: "PENDING", finalMaster: false,
        publishApproved: false, nextGate: "VIDEO_QUALITY_AND_HUMAN_REVIEW",
      });
      if (!result.dispatched) throw new Error("EXPECTED_FENCED_DISPATCH");
      const asset = await first<{
        reviewDecision: string; checksumSha256: string; byteSize: number; provenanceJson: string; storageKey: string;
      }>(sql`SELECT reviewDecision, checksumSha256, byteSize, provenanceJson, storageKey
             FROM creatorAssets WHERE id = ${result.assetId}`);
      const bytes = outputs.get(asset.storageKey);
      expect(asset.storageKey).toMatch(/export-[1-9][0-9]*_a0b1c2d3\\.mp4$/);
      expect(bytes).toBeDefined();
      expect(asset.reviewDecision).toBe("PENDING");
      expect(asset.byteSize).toBe(bytes!.byteLength);
      expect(asset.checksumSha256).toBe(digest(bytes!));
      const provenance = JSON.parse(asset.provenanceJson);
      expect(provenance).toMatchObject({
        source: "deterministic-creator-render", renderer: "ffmpeg",
        audioMasterAssetId: ids.audio, visualAssetIds: [ids.visual],
        outputEvidence: { width: 1920, height: 1080, fps: 24, durationSeconds: 2, hasAudio: true },
      });
      expect(provenance.intentFingerprint).toMatch(/^[a-f0-9]{64}$/);
      const exportRow = await first<{ status: string; assetId: number; checksumSha256: string }>(
        sql`SELECT status, assetId, checksumSha256 FROM creatorExports WHERE id = ${result.exportId}`,
      );
      expect(exportRow).toMatchObject({ status: "SUCCEEDED", assetId: result.assetId, checksumSha256: asset.checksumSha256 });
      const claimRow = await first<{ state: string; outputAssetId: number }>(
        sql`SELECT state, outputAssetId FROM creatorRenderClaims WHERE id = ${result.claimId}`,
      );
      expect(claimRow).toMatchObject({ state: "SUCCEEDED", outputAssetId: result.assetId });

      const persisted = join(dir, "persisted-candidate.mp4");
      writeFileSync(persisted, bytes!);
      const probe = JSON.parse(execFileSync("ffprobe", [
        "-v", "error", "-select_streams", "v:0", "-show_entries",
        "stream=width,height,avg_frame_rate,nb_frames", "-of", "json", persisted,
      ], { encoding: "utf8", timeout: 15_000 })) as {
        streams: Array<{ width: number; height: number; avg_frame_rate: string; nb_frames: string }>;
      };
      expect(probe.streams[0]).toMatchObject({ width: 1920, height: 1080, avg_frame_rate: "24/1", nb_frames: "48" });

      const duplicate = await caller().renderFencedCandidate(input);
      expect(duplicate).toMatchObject({
        dispatched: false, claimId: result.claimId, exportId: result.exportId,
        state: "SUCCEEDED", finalMaster: false, publishApproved: false,
      });
      expect(outputs.size).toBe(1);
      expect(JSON.stringify(duplicate)).not.toContain("leaseToken");
    }, 120_000);

    it("fences concurrent API dispatches to one real FFmpeg execution for a new Tamil caption snapshot", async () => {
      // A new locked caption changes the source fingerprint and creates one
      // additional candidate; the first successful render remains immutable.
      await exec(sql`UPDATE creatorCaptionCues SET text = 'வேல் முருகா அரோகரா'
        WHERE timelineId = ${ids.timeline}`);
      vi.stubEnv("CREATOR_FENCED_RENDER_ENABLED", "true");
      const input = {
        workspaceId: 7, creatorProjectId: ids.project,
        timelineId: ids.timeline, confirmCandidateOnly: true as const,
      };
      const results = await Promise.all([
        caller().renderFencedCandidate(input),
        caller().renderFencedCandidate(input),
      ]);
      const winners = results.filter(result => result.dispatched);
      const duplicates = results.filter(result => !result.dispatched);
      expect(winners).toHaveLength(1);
      expect(duplicates).toHaveLength(1);
      const winner = winners[0];
      const duplicate = duplicates[0];
      expect(duplicate.claimId).toBe(winner.claimId);
      expect(duplicate.exportId).toBe(winner.exportId);
      expect(JSON.stringify(results)).not.toContain("leaseToken");
      expect(outputs.size).toBe(2); // Run36 baseline + exactly one new render.
      const [exports] = await exec(sql`SELECT status FROM creatorExports
        WHERE id = ${winner.exportId}`) as unknown as [[{ status: string }]];
      expect(exports[0].status).toBe("SUCCEEDED");
      const [claims] = await exec(sql`SELECT state FROM creatorRenderClaims
        WHERE id = ${winner.claimId}`) as unknown as [[{ state: string }]];
      expect(claims[0].state).toBe("SUCCEEDED");
    }, 120_000);
  },
);