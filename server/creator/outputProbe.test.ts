import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { probeCreatorRenderedOutput } from "./outputProbe";

const target = { width: 320, height: 180, fps: 24, durationSeconds: 2, hasAudio: true };
const probeJson = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "2.000000" },
  streams: [
    { codec_type: "video", codec_name: "h264", width: 320, height: 180, avg_frame_rate: "24/1", r_frame_rate: "24/1" },
    { codec_type: "audio", codec_name: "aac" },
  ],
  ...overrides,
});
const run = (text: string) => async () => text;

describe("Creator real-output technical evidence", () => {
  it("accepts a conformant FFprobe result without fabricating human scores", async () => {
    expect(await probeCreatorRenderedOutput("/local/master.mp4", target, run(probeJson())))
      .toEqual(target);
  });
  it("rejects missing audio before other output-conformance checks", async () => {
    await expect(probeCreatorRenderedOutput("/local/master.mp4", target, run(probeJson({
      format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "2.500000" },
      streams: [{ codec_type: "video", codec_name: "h264", width: 640, height: 360, avg_frame_rate: "30/1", r_frame_rate: "30/1" }],
    })))).rejects.toThrow("CREATOR_RENDER_OUTPUT_AUDIO_CODEC_INVALID");
  });
  it("rejects invalid JSON, missing video and invalid frame-rate metadata", async () => {
    await expect(probeCreatorRenderedOutput("x", target, run("not json")))
      .rejects.toThrow("CREATOR_RENDER_FFPROBE_INVALID_JSON");
    await expect(probeCreatorRenderedOutput("x", target, run(probeJson({ streams: [{ codec_type: "audio", codec_name: "aac" }] }))))
      .rejects.toThrow("CREATOR_RENDER_FFPROBE_VIDEO_STREAM_INVALID");
    await expect(probeCreatorRenderedOutput("x", target, run(probeJson({
      streams: [
        { codec_type: "video", codec_name: "h264", width: 320, height: 180, avg_frame_rate: "0/0", r_frame_rate: "0/0" },
        { codec_type: "audio", codec_name: "aac" },
      ],
    })))).rejects.toThrow("CREATOR_RENDER_FFPROBE_METADATA_INVALID");
  });
  it("rejects mixed-codec, duplicate AAC and missing audio streams", async () => {
    const video = { codec_type: "video", codec_name: "h264", width: 320, height: 180, avg_frame_rate: "24/1", r_frame_rate: "24/1" };
    for (const audioStreams of [
      [{ codec_type: "audio", codec_name: "aac" }, { codec_type: "audio", codec_name: "mp3" }],
      [{ codec_type: "audio", codec_name: "aac" }, { codec_type: "audio", codec_name: "aac" }],
      [],
    ]) {
      await expect(probeCreatorRenderedOutput("x", target, run(probeJson({
        streams: [video, ...audioStreams],
      })))).rejects.toThrow("CREATOR_RENDER_OUTPUT_AUDIO_CODEC_INVALID");
    }
  });
  it("rejects wrong resolution, frame rate and duration with a valid AAC stream", async () => {
    const validAudio = { codec_type: "audio", codec_name: "aac" };
    const video = (overrides: Record<string, unknown> = {}) => ({
      codec_type: "video", codec_name: "h264", width: 320, height: 180,
      avg_frame_rate: "24/1", r_frame_rate: "24/1", ...overrides,
    });
    const cases: Array<{ name: string; overrides: Record<string, unknown>; error: string }> = [
      { name: "width", overrides: { streams: [video({ width: 640 }), validAudio] }, error: "CREATOR_RENDER_OUTPUT_NONCONFORMANT:width" },
      { name: "height", overrides: { streams: [video({ height: 360 }), validAudio] }, error: "CREATOR_RENDER_OUTPUT_NONCONFORMANT:height" },
      { name: "fps", overrides: { streams: [video({ avg_frame_rate: "30/1", r_frame_rate: "30/1" }), validAudio] }, error: "CREATOR_RENDER_OUTPUT_NONCONFORMANT:fps" },
      { name: "duration", overrides: { format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "2.500000" } }, error: "CREATOR_RENDER_OUTPUT_NONCONFORMANT:duration" },
    ];
    for (const testCase of cases) {
      await expect(probeCreatorRenderedOutput("x", target, run(probeJson(testCase.overrides)),))
        .rejects.toThrow(testCase.error);
    }
  });
  it("rejects wrong codecs, container and divergent CFR evidence", async () => {
    await expect(probeCreatorRenderedOutput("x", target, run(probeJson({
      streams: [
        { codec_type: "video", codec_name: "vp9", width: 320, height: 180, avg_frame_rate: "24/1", r_frame_rate: "24/1" },
        { codec_type: "audio", codec_name: "aac" },
      ],
    })))).rejects.toThrow("CREATOR_RENDER_OUTPUT_VIDEO_CODEC_INVALID");
    await expect(probeCreatorRenderedOutput("x", target, run(probeJson({
      streams: [
        { codec_type: "video", codec_name: "h264", width: 320, height: 180, avg_frame_rate: "24/1", r_frame_rate: "24/1" },
        { codec_type: "audio", codec_name: "mp3" },
      ],
    })))).rejects.toThrow("CREATOR_RENDER_OUTPUT_AUDIO_CODEC_INVALID");
    await expect(probeCreatorRenderedOutput("x", target, run(probeJson({
      format: { format_name: "matroska,webm", duration: "2.000000" },
    })))).rejects.toThrow("CREATOR_RENDER_OUTPUT_CONTAINER_INVALID");
    await expect(probeCreatorRenderedOutput("x", target, run(probeJson({
      streams: [
        { codec_type: "video", codec_name: "h264", width: 320, height: 180, avg_frame_rate: "19/1", r_frame_rate: "24/1" },
        { codec_type: "audio", codec_name: "aac" },
      ],
    })))).rejects.toThrow("CREATOR_RENDER_OUTPUT_NONCONFORMANT:fps");
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
