import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { probeCreatorRenderedOutput } from "./outputProbe";

const target = { width: 320, height: 180, fps: 24, durationSeconds: 2, hasAudio: true };
const probeJson = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  format: { duration: "2.000000" },
  streams: [
    { codec_type: "video", width: 320, height: 180, avg_frame_rate: "24/1", r_frame_rate: "24/1" },
    { codec_type: "audio" },
  ],
  ...overrides,
});
const run = (text: string) => async () => text;

describe("Creator real-output technical evidence", () => {
  it("accepts a conformant FFprobe result without fabricating human scores", async () => {
    expect(await probeCreatorRenderedOutput("/local/master.mp4", target, run(probeJson())))
      .toEqual(target);
  });
  it("rejects wrong resolution, frame rate, duration, and missing audio before storage", async () => {
    await expect(probeCreatorRenderedOutput("/local/master.mp4", target, run(probeJson({
      format: { duration: "2.500000" },
      streams: [{ codec_type: "video", width: 640, height: 360, avg_frame_rate: "30/1" }],
    })))).rejects.toThrow("CREATOR_RENDER_OUTPUT_NONCONFORMANT:width,height,fps,duration,audio");
  });
  it("rejects invalid JSON, missing video and invalid frame-rate metadata", async () => {
    await expect(probeCreatorRenderedOutput("x", target, run("not json")))
      .rejects.toThrow("CREATOR_RENDER_FFPROBE_INVALID_JSON");
    await expect(probeCreatorRenderedOutput("x", target, run(probeJson({ streams: [{ codec_type: "audio" }] }))))
      .rejects.toThrow("CREATOR_RENDER_FFPROBE_VIDEO_STREAM_INVALID");
    await expect(probeCreatorRenderedOutput("x", target, run(probeJson({
      streams: [{ codec_type: "video", width: 320, height: 180, avg_frame_rate: "0/0", r_frame_rate: "0/0" }, { codec_type: "audio" }],
    })))).rejects.toThrow("CREATOR_RENDER_FFPROBE_METADATA_INVALID");
  });
});

const ffmpegAvailable = spawnSync("ffmpeg", ["-version"]).status === 0 &&
  spawnSync("ffprobe", ["-version"]).status === 0;
describe.skipIf(!ffmpegAvailable)("Creator real FFmpeg -> FFprobe technical acceptance", () => {
  it("probes actual decodable H264/AAC media", async () => {
    const dir = mkdtempSync(join(tmpdir(), "creator-probe-"));
    try {
      const out = join(dir, "candidate.mp4");
      execFileSync("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "color=c=0x203040:s=320x180:r=24:d=2",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2",
        "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p",
        "-c:a", "aac", out,
      ], { timeout: 45_000 });
      const evidence = await probeCreatorRenderedOutput(out, target);
      expect(evidence).toMatchObject({ width: 320, height: 180, fps: 24, hasAudio: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
