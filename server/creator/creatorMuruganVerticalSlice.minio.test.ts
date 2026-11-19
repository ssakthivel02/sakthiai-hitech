import { createHash, randomInt } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { runCreatorRenderWorker, resolveCreatorCaptionFonts } from "./renderWorker";
import { scoreCreatorRenderQuality, loadCreatorQualityPolicy } from "./qualityGate";
import { storageVerifySha256 } from "../storage";

/**
 * Real FFmpeg/FFprobe + real disposable MinIO acceptance of the final media leg.
 * All source media is synthetic; this is NOT a Gemini/Veo call, Murugan approval,
 * or an authorization to publish. Never use a managed storage endpoint.
 */
const enabled = process.env.CREATOR_MINIO_TEST_ACK === "disposable-local-only";
const exec = promisify(execFile);

function requireDisposableStorage() {
  const endpoint = process.env.STORAGE_ENDPOINT ?? "";
  if (!endpoint || new URL(endpoint).hostname !== "127.0.0.1" ||
      process.env.STORAGE_BUCKET !== "creator-minio-ci" ||
      process.env.STORAGE_FORCE_PATH_STYLE !== "true") {
    throw new Error("CREATOR_MINIO_DISPOSABLE_LOOPBACK_GUARD");
  }
  return endpoint;
}

function ppm(r: number, g: number, b: number) {
  const width = 320, height = 180;
  const pixels = Buffer.alloc(width * height * 3);
  for (let i = 0; i < pixels.length; i += 3) {
    pixels[i] = r; pixels[i + 1] = g; pixels[i + 2] = b;
  }
  return Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`), pixels]);
}

describe.skipIf(!enabled)("Murugan Creator P0: real FFmpeg and MinIO candidate acceptance", { timeout: 120_000 }, () => {
  it("renders 2 synthetic shots with a Tamil subtitle and audio, verifies immutable bytes, and stays review-pending", async () => {
    const endpoint = requireDisposableStorage();
    const s3 = new S3Client({
      endpoint, region: process.env.STORAGE_REGION ?? "us-east-1", forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.STORAGE_ACCESS_KEY_ID ?? "",
        secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY ?? "",
      },
    });
    await s3.send(new CreateBucketCommand({ Bucket: "creator-minio-ci" })).catch(error => {
      if (error?.name !== "BucketAlreadyOwnedByYou" && error?.name !== "BucketAlreadyExists") throw error;
    });
    const dir = await mkdtemp(join(tmpdir(), "sakthiai-murugan-p0-"));
    try {
      const first = join(dir, "shot-1.ppm");
      const last = join(dir, "shot-2.ppm");
      const audio = join(dir, "approved-test-audio.wav");
      await Promise.all([
        writeFile(first, ppm(120, 32, 12)),
        writeFile(last, ppm(18, 48, 125)),
      ]);
      await exec(process.env.FFMPEG_PATH?.trim() || "ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=2:sample_rate=48000",
        "-c:a", "pcm_s16le", audio,
      ], { timeout: 20_000 });

      const exportId = randomInt(1, 1_000_000_000);
      const rendered = await runCreatorRenderWorker({
        workspaceId: 7, creatorProjectId: 11, timelineId: 13, exportId,
        width: 1920, height: 1080, fps: 24, audioDurationMs: 2000,
        audioSourceUrl: audio,
        captionFonts: resolveCreatorCaptionFonts(),
        visualItems: [
          { assetId: 101, shotId: 1, assetType: "IMAGE", sourceUrl: first, startMs: 0, endMs: 1000, approved: true },
          { assetId: 102, shotId: 2, assetType: "IMAGE", sourceUrl: last, startMs: 1000, endMs: 2000, approved: true },
        ],
        captions: [
          { startMs: 0, endMs: 1000, text: "வேல் முருகா", language: "ta", locked: true },
          { startMs: 1000, endMs: 2000, text: "அரோகரா", language: "ta", locked: true },
        ],
      });
      expect(rendered).toMatchObject({
        renderer: "ffmpeg", width: 1920, height: 1080, fps: 24,
        durationMs: 2000, frameCount: 48, visualAssetIds: [101, 102],
        outputEvidence: { width: 1920, height: 1080, fps: 24, hasAudio: true },
      });
      expect(rendered.storageKey).toMatch(/^creator\/7\/11\/renders\/timeline-13\/export-\d+_[0-9a-f]{8}\.mp4$/);
      expect(rendered.checksumSha256).toMatch(/^[0-9a-f]{64}$/);
      await expect(storageVerifySha256(rendered.storageKey, rendered.byteSize, rendered.checksumSha256))
        .resolves.toBeUndefined();

      // Technical conformance is measurable; no fabricated human scores or approval.
      const { spec } = loadCreatorQualityPolicy();
      const unreviewedScores = Object.fromEntries(spec.sakthiaiAcceptanceDimensions.map(item => [item.id, 0]));
      const quality = scoreCreatorRenderQuality({
        reviewerType: "ASSISTED_HUMAN", dimensionScores: unreviewedScores, criticalDefects: [],
        actual: rendered.outputEvidence,
        target: { width: 1920, height: 1080, fps: 24, durationSeconds: 2, hasAudio: true },
      });
      expect(quality.outputConformance.verified).toBe(true);
      expect(quality.decision).toBe("REGENERATE");
      expect(quality.publishHumanReviewSatisfied).toBe(false);
      expect(createHash("sha256").update("not-the-rendered-media").digest("hex"))
        .not.toBe(rendered.checksumSha256);
    } finally {
      await rm(dir, { recursive: true, force: true });
      s3.destroy();
    }
  });
});
