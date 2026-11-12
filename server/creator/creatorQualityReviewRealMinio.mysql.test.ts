import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { CreateBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDatabase, type TestDatabase } from "../testing/mysqlTestDb";

/**
 * Real disposable MySQL + real loopback MinIO + FFmpeg-produced 16:9 candidate.
 * Never use hosted storage or provider credentials. Human PASS inputs below are
 * TEST FIXTURES, not actual Tamil/visual approval or authorization to publish.
 * Unlike reviewAuthorization.mysql.test.ts, storage verification is NOT mocked.
 */
const holder = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("../db", async original => ({
  ...(await original<typeof import("../db")>()),
  getDb: async () => holder.db,
}));

import { finalizeCreatorMaster, recordCreatorHumanReview, recordCreatorQualityReview } from "./reviewService";
import { linkCreatorRemediationReplacement } from "./remediationLineage";

const exec = promisify(execFile);
const enabled = process.env.CREATOR_MINIO_TEST_ACK === "disposable-local-only";
const dimensions = {
  "VQ-CONTENT-01": 5, "VQ-TEMPORAL-01": 5, "VQ-IDENTITY-01": 5,
  "VQ-VISUAL-01": 5, "VQ-CAMERA-01": 5, "VQ-AUDIO-01": 5,
  "VQ-TEXT-01": 5, "VQ-DELIVERY-01": 5,
};
const zeroDimensions = Object.fromEntries(Object.keys(dimensions).map(key => [key, 0]));

function requireDisposableEnvironment() {
  const endpoint = process.env.STORAGE_ENDPOINT ?? "";
  if (!process.env.TEST_DATABASE_URL ||
      !endpoint || new URL(endpoint).hostname !== "127.0.0.1" ||
      process.env.STORAGE_BUCKET !== "creator-minio-ci" ||
      process.env.STORAGE_FORCE_PATH_STYLE !== "true") {
    throw new Error("CREATOR_REVIEW_MINIO_DISPOSABLE_ONLY");
  }
  return endpoint;
}

describe.skipIf(!enabled)("Creator quality and human review: real MinIO + MySQL", { timeout: 120_000 }, () => {
  let database: TestDatabase;
  let s3: S3Client;
  let dir: string;
  let projectId: number;
  let timelineId: number;
  let audioId: number;
  let renderedBytes: Buffer;
  let checksum: string;
  let measured: { width: number; height: number; fps: number; durationSeconds: number; hasAudio: boolean };
  const run = (statement: ReturnType<typeof sql>) => database.db.execute(statement);
  const one = async <T>(statement: ReturnType<typeof sql>) =>
    ((await run(statement)) as unknown as [T[]])[0][0] as T;
  const scope = (assetId: number) => ({
    workspaceId: 7, creatorProjectId: projectId, assetId,
  });
  const countReviews = async (assetId: number) =>
    Number((await one<{ n: number }>(sql`SELECT COUNT(*) AS n FROM creatorReviews WHERE assetId = ${assetId}`)).n);
  const decision = async (assetId: number) =>
    (await one<{ reviewDecision: string }>(sql`SELECT reviewDecision FROM creatorAssets WHERE id = ${assetId}`)).reviewDecision;

  beforeAll(async () => {
    const endpoint = requireDisposableEnvironment();
    s3 = new S3Client({
      endpoint, region: process.env.STORAGE_REGION || "us-east-1", forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.STORAGE_ACCESS_KEY_ID || "",
        secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY || "",
      },
    });
    await s3.send(new CreateBucketCommand({ Bucket: "creator-minio-ci" })).catch(error => {
      if (error?.name !== "BucketAlreadyOwnedByYou" && error?.name !== "BucketAlreadyExists") throw error;
    });

    dir = await mkdtemp(join(tmpdir(), "creator-review-minio-"));
    const mp4 = join(dir, "synthetic-16x9.mp4");
    await exec(process.env.FFMPEG_PATH?.trim() || "ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-f", "lavfi", "-i", "color=c=blue:s=1920x1080:r=24:d=2",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2",
      "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-movflags", "+faststart", mp4,
    ], { timeout: 60_000 });
    const { stdout } = await exec(process.env.FFPROBE_PATH?.trim() || "ffprobe", [
      "-v", "error", "-show_entries", "stream=codec_type,width,height,r_frame_rate:format=duration",
      "-of", "json", mp4,
    ], { timeout: 20_000 });
    const probe = JSON.parse(stdout) as {
      streams: Array<{ codec_type: string; width?: number; height?: number; r_frame_rate?: string }>;
      format: { duration: string };
    };
    const video = probe.streams.find(stream => stream.codec_type === "video");
    const [numerator, denominator] = (video?.r_frame_rate ?? "0/1").split("/").map(Number);
    measured = {
      width: video?.width ?? 0, height: video?.height ?? 0,
      fps: numerator / denominator, durationSeconds: Number(probe.format.duration),
      hasAudio: probe.streams.some(stream => stream.codec_type === "audio"),
    };
    expect(measured.width).toBe(1920);
    expect(measured.height).toBe(1080);
    expect(measured.fps).toBe(24);
    expect(measured.hasAudio).toBe(true);
    expect(Math.abs(measured.durationSeconds - 2)).toBeLessThan(0.1);
    renderedBytes = await readFile(mp4);
    checksum = createHash("sha256").update(renderedBytes).digest("hex");

    database = await createTestDatabase();
    holder.db = database.db;
    await run(sql`INSERT INTO creatorProjects (workspaceId, name) VALUES (7, 'review-minio-disposable')`);
    projectId = (await one<{ id: number }>(sql`SELECT id FROM creatorProjects WHERE name = 'review-minio-disposable'`)).id;
    await run(sql`INSERT INTO creatorAssets (workspaceId, creatorProjectId, assetType, mimeType, storageKey, checksumSha256, byteSize, immutable, provenanceJson, reviewDecision)
      VALUES (7, ${projectId}, 'AUDIO_MASTER', 'audio/wav', 'disposable/approved-audio.wav',
        ${"a".repeat(64)}, 10, 1, '{"durationMs":2000}', 'APPROVED')`);
    audioId = (await one<{ id: number }>(sql`SELECT id FROM creatorAssets WHERE assetType = 'AUDIO_MASTER' AND creatorProjectId = ${projectId}`)).id;
    await run(sql`INSERT INTO creatorTimelines (workspaceId, creatorProjectId, name, audioMasterAssetId, width, height, fps)
      VALUES (7, ${projectId}, '16:9 review', ${audioId}, 1920, 1080, 24)`);
    timelineId = (await one<{ id: number }>(sql`SELECT id FROM creatorTimelines WHERE creatorProjectId = ${projectId}`)).id;
  });

  afterAll(async () => {
    holder.db = undefined;
    await database?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
    s3?.destroy();
  });

  async function candidate(label: string) {
    const storageKey = `creator/7/${projectId}/renders/review-minio-${label}.mp4`;
    await s3.send(new PutObjectCommand({
      Bucket: "creator-minio-ci", Key: storageKey, Body: renderedBytes, ContentType: "video/mp4",
    }));
    const provenance = JSON.stringify({
      source: "deterministic-creator-render", timelineId, audioMasterAssetId: audioId,
      audioMasterChecksumSha256: "a".repeat(64), width: 1920, height: 1080, fps: 24,
      durationMs: 2000, outputEvidence: measured,
    });
    await run(sql`INSERT INTO creatorAssets (workspaceId, creatorProjectId, assetType, mimeType,
      storageKey, checksumSha256, byteSize, immutable, provenanceJson, reviewDecision)
      VALUES (7, ${projectId}, 'RENDER', 'video/mp4', ${storageKey}, ${checksum},
        ${renderedBytes.length}, 1, ${provenance}, 'PENDING')`);
    const assetId = (await one<{ id: number }>(sql`SELECT id FROM creatorAssets WHERE storageKey = ${storageKey}`)).id;
    return { assetId, storageKey };
  }

  async function quality(assetId: number, dimensionScores: Record<string, number> = dimensions) {
    return recordCreatorQualityReview({
      ...scope(assetId), reviewerUserId: 501, reviewerType: "HUMAN",
      sourcePromptOrStoryboard: "synthetic, rights-safe test storyboard",
      dimensionScores, criticalDefects: [], notes: "Disposable integration fixture only",
    });
  }

  it("binds a PASS quality review to real stored candidate bytes, then honors Tamil rejection", async () => {
    const { assetId, storageKey } = await candidate("tamil-reject");
    const result = await quality(assetId);
    expect(result.decision).toBe("PASS");
    const saved = await one<{ scoresJson: string }>(sql`SELECT scoresJson FROM creatorReviews
      WHERE assetId = ${assetId} AND reviewType = 'QUALITY'`);
    expect(JSON.parse(saved.scoresJson).candidateArtifact).toEqual({
      storageKey, checksumSha256: checksum, byteSize: renderedBytes.length,
    });
    await recordCreatorHumanReview({
      ...scope(assetId), reviewerUserId: 501, reviewType: "HUMAN_TAMIL",
      decision: "REJECT", notes: "Test-only Tamil rejection",
    });
    expect(await decision(assetId)).toBe("REJECTED");
    await expect(finalizeCreatorMaster(scope(assetId))).rejects.toThrow("CREATOR_FINAL_MASTER_REJECTED");
    expect(await countReviews(assetId)).toBe(2);
  });

  it("persists a remediation decision and refuses human PASS or final promotion", async () => {
    const { assetId } = await candidate("regenerate");
    const result = await quality(assetId, zeroDimensions);
    expect(result.decision).toBe("REGENERATE");
    await expect(recordCreatorHumanReview({
      ...scope(assetId), reviewerUserId: 501, reviewType: "HUMAN_VISUAL",
      decision: "PASS", notes: "Test-only attempt",
    })).rejects.toThrow("CREATOR_HUMAN_REVIEW_BLOCKED_BY_QUALITY");
    await expect(finalizeCreatorMaster(scope(assetId))).rejects.toThrow("CREATOR_FINAL_MASTER_QUALITY_PASS_REQUIRED");
    expect(await countReviews(assetId)).toBe(1);
    expect(await decision(assetId)).toBe("PENDING");
  });

  it("fails closed when the MinIO object is overwritten before quality review", async () => {
    const { assetId, storageKey } = await candidate("tamper-before-quality");
    await s3.send(new PutObjectCommand({
      Bucket: "creator-minio-ci", Key: storageKey, Body: Buffer.from("tampered"),
    }));
    await expect(quality(assetId)).rejects.toThrow("CREATOR_REVIEW_CANDIDATE_STORAGE_UNVERIFIED");
    expect(await countReviews(assetId)).toBe(0);
    expect(await decision(assetId)).toBe("PENDING");
  });

  it("fails closed when the scored object changes before Tamil review", async () => {
    const { assetId, storageKey } = await candidate("tamper-before-human");
    await quality(assetId);
    await s3.send(new PutObjectCommand({
      Bucket: "creator-minio-ci", Key: storageKey, Body: Buffer.from("tampered-after-quality"),
    }));
    await expect(recordCreatorHumanReview({
      ...scope(assetId), reviewerUserId: 501, reviewType: "HUMAN_TAMIL",
      decision: "PASS", notes: "Test-only simulated Tamil PASS",
    })).rejects.toThrow("CREATOR_REVIEW_CANDIDATE_STORAGE_UNVERIFIED");
    expect(await countReviews(assetId)).toBe(1);
    expect(await decision(assetId)).toBe("PENDING");
  });

  it("rechecks MinIO bytes before final promotion even after simulated PASS reviews", async () => {
    const { assetId, storageKey } = await candidate("tamper-before-final");
    await quality(assetId);
    for (const reviewType of ["HUMAN_TAMIL", "HUMAN_VISUAL"] as const) {
      await recordCreatorHumanReview({
        ...scope(assetId), reviewerUserId: 501, reviewType,
        decision: "PASS", notes: `TEST FIXTURE ONLY: ${reviewType}`,
      });
    }
    await s3.send(new PutObjectCommand({
      Bucket: "creator-minio-ci", Key: storageKey, Body: Buffer.from("tampered-after-review"),
    }));
    await expect(finalizeCreatorMaster(scope(assetId)))
      .rejects.toThrow("CREATOR_REVIEW_CANDIDATE_STORAGE_UNVERIFIED");
    expect(await countReviews(assetId)).toBe(3);
    expect(await decision(assetId)).toBe("PENDING");
  });

  it("verifies actual MinIO source and replacement bytes before immutable remediation linkage", async () => {
    const source = await candidate("lineage-real-source");
    // Remediation must produce a genuinely different rendered candidate, not a
    // second object key containing identical MP4 bytes.
    const replacementMp4 = join(dir, "lineage-replacement-red.mp4");
    await exec(process.env.FFMPEG_PATH?.trim() || "ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-f", "lavfi", "-i", "color=c=red:s=1920x1080:r=24:d=2",
      "-f", "lavfi", "-i", "sine=frequency=660:sample_rate=48000:duration=2",
      "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-movflags", "+faststart", replacementMp4,
    ], { timeout: 60_000 });
    const replacementBytes = await readFile(replacementMp4);
    const replacementChecksum = createHash("sha256").update(replacementBytes).digest("hex");
    expect(replacementChecksum).not.toBe(checksum);
    const replacement = await candidate("lineage-real-replacement");
    await s3.send(new PutObjectCommand({
      Bucket: "creator-minio-ci", Key: replacement.storageKey,
      Body: replacementBytes, ContentType: "video/mp4",
    }));
    await run(sql`UPDATE creatorAssets SET checksumSha256 = ${replacementChecksum},
      byteSize = ${replacementBytes.length} WHERE id = ${replacement.assetId}`);
    const sourceQuality = await quality(source.assetId, zeroDimensions);
    expect(sourceQuality.decision).toBe("REGENERATE");
    const sourceReview = await one<{ id: number }>(sql`SELECT id FROM creatorReviews
      WHERE assetId = ${source.assetId} AND reviewType = 'QUALITY' ORDER BY id DESC LIMIT 1`);

    // Linkage requires a completed, checksum-bound export for each render.
    for (const item of [source, replacement]) {
      await run(sql`INSERT INTO creatorExports
        (workspaceId, creatorProjectId, timelineId, status, width, height, format, renderer, assetId, checksumSha256)
        VALUES (7, ${projectId}, ${timelineId}, 'SUCCEEDED', 1920, 1080, 'mp4', 'ffmpeg',
          ${item.assetId}, ${item.assetId === source.assetId ? checksum : replacementChecksum})`);
      const exportRow = await one<{ id: number }>(sql`SELECT MAX(id) AS id FROM creatorExports
        WHERE assetId = ${item.assetId}`);
      const provenance = JSON.stringify({
        source: "deterministic-creator-render", exportId: exportRow.id, timelineId,
        audioMasterAssetId: audioId, audioMasterChecksumSha256: "a".repeat(64),
        width: 1920, height: 1080, fps: 24, durationMs: 2000,
      });
      await run(sql`UPDATE creatorAssets SET provenanceJson = ${provenance} WHERE id = ${item.assetId}`);
    }

    const args = {
      workspaceId: 7, creatorProjectId: projectId, reviewerUserId: 501,
      sourceCandidateAssetId: source.assetId, sourceQualityReviewId: sourceReview.id,
      replacementCandidateAssetId: replacement.assetId,
      expectedSourceChecksumSha256: checksum, expectedReplacementChecksumSha256: replacementChecksum,
    };
    // Deliberately corrupt replacement bytes, leaving DB checksums unchanged.
    await s3.send(new PutObjectCommand({
      Bucket: "creator-minio-ci", Key: replacement.storageKey, Body: Buffer.from("changed replacement"),
    }));
    await expect(linkCreatorRemediationReplacement(args))
      .rejects.toThrow("CREATOR_REMEDIATION_STORAGE_UNVERIFIED");
    const before = await one<{ n: number }>(sql`SELECT COUNT(*) AS n FROM creatorRemediationLineage
      WHERE sourceQualityReviewId = ${sourceReview.id}`);
    expect(Number(before.n)).toBe(0);

    // Restore exact bytes: a valid link must not create inherited approvals.
    await s3.send(new PutObjectCommand({
      Bucket: "creator-minio-ci", Key: replacement.storageKey,
      Body: replacementBytes, ContentType: "video/mp4",
    }));
    const linked = await linkCreatorRemediationReplacement(args);
    expect(linked).toMatchObject({
      replacementRequiresFreshQuality: true,
      replacementRequiresFreshTamilReview: true,
      replacementRequiresFreshVisualReview: true,
    });
    expect(await countReviews(replacement.assetId)).toBe(0);
    await expect(finalizeCreatorMaster(scope(replacement.assetId)))
      .rejects.toThrow("CREATOR_FINAL_MASTER_QUALITY_PASS_REQUIRED");

    // All three decisions must be fresh and bound to the replacement bytes.
    const replacementQuality = await quality(replacement.assetId);
    expect(replacementQuality.decision).toBe("PASS");
    expect(await countReviews(replacement.assetId)).toBe(1);
    await expect(finalizeCreatorMaster(scope(replacement.assetId)))
      .rejects.toThrow("CREATOR_FINAL_MASTER_TAMIL_PASS_REQUIRED");

    await recordCreatorHumanReview({
      ...scope(replacement.assetId), reviewerUserId: 501,
      reviewType: "HUMAN_TAMIL", decision: "PASS",
      notes: "TEST FIXTURE ONLY: replacement Tamil review",
    });
    await expect(finalizeCreatorMaster(scope(replacement.assetId)))
      .rejects.toThrow("CREATOR_FINAL_MASTER_VISUAL_PASS_REQUIRED");

    await recordCreatorHumanReview({
      ...scope(replacement.assetId), reviewerUserId: 502,
      reviewType: "HUMAN_VISUAL", decision: "PASS",
      notes: "TEST FIXTURE ONLY: replacement visual review",
    });
    expect(await countReviews(replacement.assetId)).toBe(3);
    expect(await countReviews(source.assetId)).toBe(1);
    await expect(finalizeCreatorMaster(scope(source.assetId)))
      .rejects.toThrow("CREATOR_FINAL_MASTER_QUALITY_PASS_REQUIRED");

    const master = await finalizeCreatorMaster(scope(replacement.assetId));
    expect(master).toMatchObject({
      assetId: replacement.assetId, checksumSha256: replacementChecksum,
      finalMaster: true, qualityPass: true, humanTamilPass: true,
      humanVisualPass: true, publishApproved: false, automaticPublish: false,
    });
    expect(await decision(replacement.assetId)).toBe("APPROVED");
    expect(await decision(source.assetId)).toBe("PENDING");
  });
});
