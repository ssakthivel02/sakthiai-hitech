import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
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
import { loadCreatorQualityPolicy } from "./qualityGate";
import { finalizeCreatorMaster, recordCreatorHumanReview, recordCreatorQualityReview } from "./reviewService";
import { storageListCreatorRenderObjects, storagePut, storageVerifySha256 } from "../storage";

const hasMediaTools = spawnSync("ffmpeg", ["-version"]).status === 0 &&
  spawnSync("ffprobe", ["-version"]).status === 0;
if (process.env.MYSQL_REQUIRED === "1" && !hasMediaTools) {
  throw new Error("CREATOR_FENCED_REAL_MEDIA_CI_FFMPEG_FFPROBE_REQUIRED");
}
const digest = (data: Buffer) => createHash("sha256").update(data).digest("hex");
/** Opt-in only: the SAME real-MySQL + real-FFmpeg route also writes to real disposable MinIO. */
const realMinio = process.env.CREATOR_MINIO_TEST_ACK === "disposable-local-only";
if (realMinio && (process.env.STORAGE_ENDPOINT !== "http://127.0.0.1:9000" ||
    process.env.STORAGE_BUCKET !== "creator-minio-ci" ||
    process.env.STORAGE_FORCE_PATH_STYLE !== "true" ||
    !process.env.TEST_DATABASE_URL?.startsWith("mysql://root:ci-only-root-password@127.0.0.1:3306"))) {
  throw new Error("CREATOR_FENCED_MINIO_MYSQL_DISPOSABLE_GUARD");
}

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
  realMinio ? "Creator fenced route MySQL + FFmpeg + real MinIO integration" :
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
          putArtifact: async (key, bytes, contentType) => {
            // In the integrated acceptance lane, the real AWS SDK writes the
            // actual FFmpeg bytes to disposable MinIO. The local map counts
            // executions only; it is NOT used as storage integrity evidence.
            const stored = realMinio
              ? await storagePut(key, bytes, contentType)
              : { key: key.replace(/\.mp4$/, "_a0b1c2d3.mp4"), url: "" };
            if (outputs.has(stored.key)) throw new Error("CREATOR_DUPLICATE_STORAGE_WRITE");
            outputs.set(stored.key, Buffer.from(bytes));
            return stored;
          },
          verifyArtifact: async (key, size, sha) => {
            if (realMinio) {
              // Actual HTTP 206 ranged GET and SHA-256 verification.
              await storageVerifySha256(key, size, sha);
            } else {
              const stored = outputs.get(key);
              if (!stored || stored.byteLength !== size || digest(stored) !== sha) {
                throw new Error("CREATOR_REAL_MEDIA_STORAGE_READBACK_FAILED");
              }
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
      expect(asset.storageKey).toMatch(/export-[1-9][0-9]*_[0-9a-f]{8}\.mp4$/);
      expect(bytes).toBeDefined();
      expect(asset.reviewDecision).toBe("PENDING");
      expect(asset.byteSize).toBe(bytes!.byteLength);
      expect(asset.checksumSha256).toBe(digest(bytes!));
      if (realMinio) {
        // Re-check AFTER transactional finalization; an in-memory map alone
        // is not evidence that the persisted S3 object still matches MySQL.
        await storageVerifySha256(asset.storageKey, asset.byteSize, asset.checksumSha256);
        const inventory = await storageListCreatorRenderObjects({
          workspaceId: 7, creatorProjectId: ids.project, timelineId: ids.timeline,
          exportId: result.exportId, claimId: result.claimId,
        });
        expect(inventory).toEqual([{ key: asset.storageKey, sizeBytes: asset.byteSize }]);
      }
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
      if (realMinio) {
        // Concurrent requests must not create two independently named S3
        // objects for the same immutable export, even if both see QUEUED.
        const inventory = await storageListCreatorRenderObjects({
          workspaceId: 7, creatorProjectId: ids.project, timelineId: ids.timeline,
          exportId: winner.exportId, claimId: winner.claimId,
        });
        expect(inventory).toHaveLength(1);
        const persisted = await first<{
          storageKey: string; byteSize: number; checksumSha256: string;
        }>(sql`SELECT storageKey, byteSize, checksumSha256 FROM creatorAssets
               WHERE id = (SELECT assetId FROM creatorExports WHERE id = ${winner.exportId})`);
        expect(inventory).toEqual([{ key: persisted.storageKey, sizeBytes: persisted.byteSize }]);
        await storageVerifySha256(persisted.storageKey, persisted.byteSize, persisted.checksumSha256);
      }
    }, 120_000);

    it.skipIf(!realMinio)("uses test-only human approvals to fence real 9:16 MySQL/FFmpeg/MinIO render and deny automatic crop approval", async () => {
      // A disposable simulated reviewer is NOT a human's approval for Murugan.
      vi.stubEnv("CREATOR_FENCED_RENDER_ENABLED", "true");
      vi.stubEnv("CREATOR_FENCED_DERIVATIVE_ENABLED", "true");
      await exec(sql`UPDATE creatorCaptionCues SET text = 'வேல் முருகா vertical-test-only'
        WHERE timelineId = ${ids.timeline}`);

      // New candidate keeps this test independent of earlier test assertions.
      const master = await caller().renderFencedCandidate({
        workspaceId: 7, creatorProjectId: ids.project, timelineId: ids.timeline,
        confirmCandidateOnly: true,
      });
      if (!master.dispatched) throw new Error("CREATOR_DERIVATIVE_TEST_MASTER_NOT_RENDERED");
      expect(master).toMatchObject({ reviewDecision: "PENDING", finalMaster: false, publishApproved: false });

      const input = {
        workspaceId: 7, creatorProjectId: ids.project,
        timelineId: ids.timeline, finalMasterAssetId: master.assetId,
      };
      const before = outputs.size;
      // No claimed derivative or FFmpeg may start with an unreviewed master.
      await expect(caller().renderVerticalDerivative(input)).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(outputs.size).toBe(before);

      const dimensions = Object.fromEntries(
        loadCreatorQualityPolicy().spec.sakthiaiAcceptanceDimensions.map(item => [item.id, 5]),
      );
      const quality = await recordCreatorQualityReview({
        workspaceId: 7, creatorProjectId: ids.project, assetId: master.assetId,
        reviewerUserId: 501, reviewerType: "HUMAN",
        sourcePromptOrStoryboard: "Synthetic fixture; not an actual Murugan approval",
        dimensionScores: dimensions, criticalDefects: [],
        notes: "TEST ONLY: simulated technical approval",
      });
      expect(quality.decision).toBe("PASS");
      for (const reviewType of ["HUMAN_TAMIL", "HUMAN_VISUAL"] as const) {
        const review = await recordCreatorHumanReview({
          workspaceId: 7, creatorProjectId: ids.project, assetId: master.assetId,
          reviewerUserId: 501, reviewType, decision: "PASS",
          notes: "TEST FIXTURE ONLY, not a genuine human review",
        });
        expect(review.decision).toBe("PASS");
      }
      const approved = await finalizeCreatorMaster({
        workspaceId: 7, creatorProjectId: ids.project, assetId: master.assetId,
      });
      expect(approved).toMatchObject({
        finalMaster: true, qualityPass: true,
        humanTamilPass: true, humanVisualPass: true,
        publishApproved: false, automaticPublish: false,
      });

      const derivative = await caller().renderVerticalDerivative(input);
      if (!derivative.dispatched) throw new Error("CREATOR_DERIVATIVE_TEST_NOT_RENDERED");
      expect(derivative).toMatchObject({
        dispatched: true, aspectRatio: "9:16", derivative: true,
        humanCropCheckRequired: true, reviewDecision: "PENDING",
        finalMaster: false, publishApproved: false,
      });
      expect(outputs.size).toBe(before + 1);
      const asset = await first<{
        reviewDecision: string; checksumSha256: string; byteSize: number;
        storageKey: string; provenanceJson: string;
      }>(sql`SELECT reviewDecision, checksumSha256, byteSize, storageKey, provenanceJson
        FROM creatorAssets WHERE id = ${derivative.assetId}`);
      expect(asset.reviewDecision).toBe("PENDING");
      expect(JSON.parse(asset.provenanceJson)).toMatchObject({
        source: "deterministic-creator-derivative",
        derivativeOfRenderAssetId: master.assetId,
        width: 1080, height: 1920, fps: 24,
        outputEvidence: { width: 1080, height: 1920, fps: 24, hasAudio: true },
      });
      await storageVerifySha256(asset.storageKey, asset.byteSize, asset.checksumSha256);

      // Independently read the real disposable S3 object and inspect MP4 bytes.
      const endpoint = process.env.STORAGE_ENDPOINT ?? "";
      if (endpoint !== "http://127.0.0.1:9000" ||
          process.env.STORAGE_BUCKET !== "creator-minio-ci") {
        throw new Error("CREATOR_DERIVATIVE_TEST_NOT_DISPOSABLE");
      }
      const s3 = new S3Client({
        endpoint, region: process.env.STORAGE_REGION || "us-east-1", forcePathStyle: true,
        credentials: {
          accessKeyId: process.env.STORAGE_ACCESS_KEY_ID || "",
          secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY || "",
        },
      });
      try {
        const object = await s3.send(new GetObjectCommand({
          Bucket: "creator-minio-ci", Key: asset.storageKey,
        }));
        if (!object.Body) throw new Error("CREATOR_DERIVATIVE_TEST_OBJECT_MISSING");
        const bytes = Buffer.from(await object.Body.transformToByteArray());
        expect(bytes.length).toBe(asset.byteSize);
        expect(digest(bytes)).toBe(asset.checksumSha256);
        const persisted = join(dir, "fenced-vertical-persisted.mp4");
        writeFileSync(persisted, bytes);
        const probe = JSON.parse(execFileSync("ffprobe", [
          "-v", "error", "-show_entries",
          "stream=codec_type,width,height,avg_frame_rate,nb_frames",
          "-of", "json", persisted,
        ], { encoding: "utf8", timeout: 15_000 })) as {
          streams: Array<{
            codec_type: string; width?: number; height?: number;
            avg_frame_rate?: string; nb_frames?: string;
          }>;
        };
        expect(probe.streams.find(stream => stream.codec_type === "video")).toMatchObject({
          width: 1080, height: 1920, avg_frame_rate: "24/1", nb_frames: "48",
        });
        expect(probe.streams.some(stream => stream.codec_type === "audio")).toBe(true);
      } finally {
        s3.destroy();
      }

      const manifest = await caller().exportManifest({
        workspaceId: 7, creatorProjectId: ids.project, exportId: derivative.exportId,
      });
      expect(manifest.output).toMatchObject({
        kind: "DELIVERY_DERIVATIVE", finalMaster: false,
        deliveryApproved: false, reviewDecision: "PENDING",
        derivativeOf: { renderAssetId: master.assetId },
      });
      expect(manifest.gates).toMatchObject({ publishApproved: false, automaticPublish: false });
      const duplicate = await caller().renderVerticalDerivative(input);
      expect(duplicate).toMatchObject({
        dispatched: false, claimId: derivative.claimId, exportId: derivative.exportId,
        finalMaster: false, publishApproved: false,
      });
      expect(outputs.size).toBe(before + 1);
      expect(JSON.stringify(duplicate)).not.toContain("leaseToken");
      expect(await storageListCreatorRenderObjects({
        workspaceId: 7, creatorProjectId: ids.project, timelineId: ids.timeline,
        exportId: derivative.exportId, claimId: derivative.claimId,
      })).toEqual([{ key: asset.storageKey, sizeBytes: asset.byteSize }]);
      const after = await first<{ reviewDecision: string }>(sql`SELECT reviewDecision
        FROM creatorAssets WHERE id = ${master.assetId}`);
      expect(after.reviewDecision).toBe("APPROVED");
    }, 120_000);

  },
);