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
  describe("video-stream completeness (full-length audio must not hide a truncated video)", () => {
    const audio = { codec_type: "audio", codec_name: "aac" };
    const video = (overrides: Record<string, unknown> = {}) => ({
      codec_type: "video", codec_name: "h264", width: 320, height: 180,
      avg_frame_rate: "24/1", r_frame_rate: "24/1", ...overrides,
    });
    const oneSecond = { width: 320, height: 180, fps: 24, durationSeconds: 1, hasAudio: true };
    const json = (videoOverrides: Record<string, unknown>) => run(probeJson({
      format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "1.000000" },
      streams: [video(videoOverrides), audio],
    }));
    it("rejects 22 of 24 frames even though container duration is a full second", async () => {
      await expect(probeCreatorRenderedOutput("x", oneSecond, json({ nb_frames: "22", duration: "0.916667" })))
        .rejects.toThrow("CREATOR_RENDER_OUTPUT_NONCONFORMANT:video_frames");
    });
    it("accepts exactly 24 of 24 frames and keeps the evidence shape unchanged", async () => {
      expect(await probeCreatorRenderedOutput("x", oneSecond, json({ nb_frames: "24", duration: "1.000000" }))).toEqual(oneSecond);
    });
    it("also rejects one missing frame and surplus frames when the count is known", async () => {
      await expect(probeCreatorRenderedOutput("x", oneSecond, json({ nb_frames: "23" }))).rejects.toThrow("video_frames");
      await expect(probeCreatorRenderedOutput("x", oneSecond, json({ nb_frames: "25" }))).rejects.toThrow("video_frames");
    });
    it("falls back to stream duration only when nb_frames is unavailable", async () => {
      await expect(probeCreatorRenderedOutput("x", oneSecond, json({ nb_frames: "N/A", duration: "0.916667" })))
        .rejects.toThrow("CREATOR_RENDER_OUTPUT_NONCONFORMANT:video_duration");
      expect(await probeCreatorRenderedOutput("x", oneSecond, json({ nb_frames: "N/A", duration: "0.980000" }))).toEqual(oneSecond);
    });
    it("does not fail media whose frame count and stream duration are both unknown", async () => {
      expect(await probeCreatorRenderedOutput("x", oneSecond, json({ nb_frames: "N/A", duration: "N/A" }))).toEqual(oneSecond);
      expect(await probeCreatorRenderedOutput("x", oneSecond, json({}))).toEqual(oneSecond);
    });
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
  it("rejects a 22/24-frame video with a full one-second audio track and accepts 24/24", async () => {
    const dir = mkdtempSync(join(tmpdir(), "creator-trunc-"));
    try {
      const ff = (args: string[]) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { timeout: 45_000 });
      const audio = join(dir, "audio.m4a");
      ff(["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1", "-c:a", "aac", audio]);
      const mux = (frames: number) => {
        const video = join(dir, `video-${frames}.mp4`);
        const out = join(dir, `candidate-${frames}.mp4`);
        ff(["-f", "lavfi", "-i", "color=c=0x203040:s=320x180:r=24", "-frames:v", String(frames), "-c:v", "libx264", "-pix_fmt", "yuv420p", video]);
        ff(["-i", video, "-i", audio, "-map", "0:v", "-map", "1:a", "-c", "copy", out]);
        return out;
      };
      const oneSecond = { width: 320, height: 180, fps: 24, durationSeconds: 1, hasAudio: true };
      const truncated = mux(22);
      // Guard the premise: container duration is a full second, only the video stream is short.
      const format = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "json", truncated], { encoding: "utf8" })) as { format: { duration: string } };
      expect(Number(format.format.duration)).toBeCloseTo(1, 2);
      await expect(probeCreatorRenderedOutput(truncated, oneSecond)).rejects.toThrow("CREATOR_RENDER_OUTPUT_NONCONFORMANT:video_frames");
      expect(await probeCreatorRenderedOutput(mux(24), oneSecond)).toEqual(oneSecond);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);
});
