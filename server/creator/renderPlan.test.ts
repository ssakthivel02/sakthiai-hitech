import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeCreatorRenderedOutput } from "./outputProbe";
import { resolveCreatorCaptionFonts } from "./renderWorker";
import { describe, expect, it } from "vitest";
import { buildDeterministicRenderPlan, frameAtMs, serializeSrt } from "./renderPlan";

const captions = [
  { startMs: 0, endMs: 1500, text: "முருகா...", language: "ta" as const, locked: true },
  { startMs: 1500, endMs: 3000, text: "என் முருகா...", language: "ta" as const, locked: true },
];

const fonts = { dir: "/srv/app/server/creator/fonts", family: "Noto Sans Tamil" };

const visuals = [
  { assetId: 11, shotId: 101, assetType: "IMAGE" as const, sourceUrl: "https://signed.example/11", startMs: 0, endMs: 1500, track: 1, sortOrder: 0, approved: true },
  { assetId: 12, shotId: 102, assetType: "VIDEO" as const, sourceUrl: "https://signed.example/12", startMs: 1500, endMs: 3000, track: 1, sortOrder: 1, approved: true },
];

describe("Creator deterministic render plan", () => {
  it("serializes locked Tamil cues as stable UTF-8 SRT", () => {
    expect(serializeSrt(captions, 3000)).toBe(
      "1\n00:00:00,000 --> 00:00:01,500\nமுருகா...\n\n2\n00:00:01,500 --> 00:00:03,000\nஎன் முருகா...\n",
    );
  });

  it("builds an audio-master-bounded 16:9 ffmpeg plan", () => {
    const plan = buildDeterministicRenderPlan({
      width: 1920,
      height: 1080,
      fps: 24,
      audioDurationMs: 3000,
      audioSourceUrl: "https://signed.example/audio-master",
      visualItems: visuals,
      captions,
      subtitlePath: "/tmp/creator-ta.srt",
      outputPath: "/tmp/master.mp4",
      captionFonts: fonts,
    });

    expect(plan.visualAssetIds).toEqual([11, 12]);
    expect(plan.frameCount).toBe(72);
    expect(plan.durationMs).toBe(3000);
    expect(plan.ffmpegArgs).toContain("libx264");
    expect(plan.ffmpegArgs).toContain("320k");
    expect(plan.ffmpegArgs.slice(plan.ffmpegArgs.indexOf("-r"), plan.ffmpegArgs.indexOf("-r") + 4))
      .toEqual(["-r", "24", "-fps_mode", "cfr"]);
    expect(plan.ffmpegArgs.at(-1)).toBe("/tmp/master.mp4");
    expect(plan.ffmpegArgs.join(" ")).toContain("concat=n=2:v=1:a=0");
    expect(plan.ffmpegArgs.join(" ")).toContain("subtitles='/tmp/creator-ta.srt':charenc=UTF-8");
    expect(plan.ffmpegArgs.join(" ")).toContain(":fontsdir='/srv/app/server/creator/fonts':force_style='FontName=Noto Sans Tamil'");
  });

  const base = {
    width: 1920, height: 1080, fps: 24, audioDurationMs: 3000, audioSourceUrl: "audio",
    visualItems: visuals, subtitlePath: "captions.srt", outputPath: "master.mp4",
  };

  it("refuses to render Tamil captions without a pinned Tamil font (no silent host-font fallback)", () => {
    expect(() => buildDeterministicRenderPlan({ ...base, captions })).toThrow("CREATOR_RENDER_TAMIL_FONT_REQUIRED");
  });

  it("does not require a Tamil font for English-only captions and adds no font options", () => {
    const plan = buildDeterministicRenderPlan({
      ...base,
      captions: [{ startMs: 0, endMs: 1500, text: "Hello", language: "en", locked: true }],
    });
    expect(plan.ffmpegArgs.join(" ")).not.toContain("fontsdir");
  });

  it("rejects a font family that could inject filter options", () => {
    expect(() => buildDeterministicRenderPlan({ ...base, captions, captionFonts: { dir: "/f", family: "X,Fontsize=1:y" } }))
      .toThrow("CREATOR_RENDER_CAPTION_FONT_FAMILY_INVALID");
    expect(() => buildDeterministicRenderPlan({ ...base, captions, captionFonts: { dir: " ", family: "Noto Sans Tamil" } }))
      .toThrow("CREATOR_RENDER_CAPTION_FONT_DIR_REQUIRED");
  });

  it("escapes the fonts directory like the subtitle path", () => {
    const plan = buildDeterministicRenderPlan({ ...base, captions, captionFonts: { dir: "C:\\fonts\\o'neil", family: "Noto Sans Tamil" } });
    expect(plan.ffmpegArgs.join(" ")).toContain("fontsdir='C\\:/fonts/o\\'neil'");
  });

  it("rejects gaps because silent black-frame synthesis is not deterministic project intent", () => {
    expect(() => buildDeterministicRenderPlan({
      width: 1920,
      height: 1080,
      fps: 24,
      audioDurationMs: 3000,
      audioSourceUrl: "audio",
      visualItems: [{ ...visuals[0], endMs: 1000 }, { ...visuals[1], startMs: 1200 }],
      captions,
      subtitlePath: "captions.srt",
      outputPath: "master.mp4",
    })).toThrow("CREATOR_RENDER_VISUAL_GAP");
  });

  it("rejects unapproved visuals before rendering", () => {
    expect(() => buildDeterministicRenderPlan({
      width: 1920,
      height: 1080,
      fps: 24,
      audioDurationMs: 3000,
      audioSourceUrl: "audio",
      visualItems: [{ ...visuals[0], approved: false }, visuals[1]],
      captions,
      subtitlePath: "captions.srt",
      outputPath: "master.mp4",
    })).toThrow("CREATOR_RENDER_VISUAL_NOT_APPROVED");
  });

  it("refuses forged SRT timestamps even if a persisted cue bypassed ingestion", () => {
    expect(() => serializeSrt([
      { startMs: 0, endMs: 1000, text: "முருகா\n00:00:01,000 --> 00:00:09,000", language: "ta", locked: true },
    ], 10000)).toThrow("CREATOR_CAPTION_SRT_TIMING_MARKUP_FORBIDDEN");
  });

  it("rejects unlocked or overlapping captions", () => {
    expect(() => serializeSrt([{ ...captions[0], locked: false }], 3000)).toThrow("CREATOR_RENDER_CAPTION_NOT_LOCKED");
    expect(() => serializeSrt([captions[0], { ...captions[1], startMs: 1400 }], 3000)).toThrow("CREATOR_RENDER_CAPTION_OVERLAP");
  });
});

/** Actual render-plan acceptance, not a direct FFprobe fixture or provider output. */
const canProbe = spawnSync("ffmpeg", ["-version"]).status === 0 &&
  spawnSync("ffprobe", ["-version"]).status === 0;
if (process.env.CI && !canProbe) throw new Error("CREATOR_REAL_MEDIA_CI_FFMPEG_FFPROBE_REQUIRED");
describe.skipIf(!canProbe)("Creator real Tamil-captioned FFmpeg CFR acceptance", () => {
  it("burns locked Tamil cues into a measured 24fps H264/AAC candidate", async () => {
    const dir = mkdtempSync(join(tmpdir(), "creator-cfr-"));
    try {
      const still = join(dir, "still.bmp");
      const audio = join(dir, "audio.wav");
      const subtitle = join(dir, "captions.ta.srt");
      const output = join(dir, "candidate.mp4");
      execFileSync("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi",
        "-i", "color=c=blue:s=320x180:r=24", "-frames:v", "1", still,
      ], { timeout: 15_000 });
      execFileSync("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi",
        "-i", "sine=frequency=440:sample_rate=48000:duration=2",
        "-c:a", "pcm_s16le", audio,
      ], { timeout: 15_000 });
      const plan = buildDeterministicRenderPlan({
        width: 320, height: 180, fps: 24, audioDurationMs: 2000,
        audioSourceUrl: audio,
        visualItems: [{
          assetId: 11, assetType: "IMAGE", sourceUrl: still,
          startMs: 0, endMs: 2000, track: 1, sortOrder: 0, approved: true,
        }],
        captions: [{
          startMs: 0, endMs: 2000, text: "வேல் முருகா",
          language: "ta", locked: true,
        }],
        subtitlePath: subtitle, outputPath: output,
        captionFonts: resolveCreatorCaptionFonts(),
      });
      writeFileSync(subtitle, plan.srt, "utf8");
      execFileSync("ffmpeg", plan.ffmpegArgs, { timeout: 45_000 });
      const evidence = await probeCreatorRenderedOutput(output, {
        width: 320, height: 180, fps: 24, durationSeconds: 2, hasAudio: true,
      });
      expect(evidence).toEqual({
        width: 320, height: 180, fps: 24, durationSeconds: 2, hasAudio: true,
      });
      const metadata = JSON.parse(execFileSync("ffprobe", [
        "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=nb_frames,avg_frame_rate",
        "-of", "json", output,
      ], { encoding: "utf8", timeout: 15_000 })) as {
        streams: Array<{ nb_frames: string; avg_frame_rate: string }>;
      };
      expect(Number(metadata.streams[0].nb_frames)).toBe(48);
      expect(metadata.streams[0].avg_frame_rate).toBe("24/1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

/** Global frame grid: every timeline boundary is rounded once, so segments tile the master with no lost or duplicated frame. */
const gridVisuals = (bounds: number[]) => bounds.slice(0, -1).map((startMs, index) => ({
  assetId: 200 + index, assetType: "IMAGE" as const, sourceUrl: `https://signed.example/${200 + index}`,
  startMs, endMs: bounds[index + 1], track: 1, sortOrder: index, approved: true,
}));
const gridPlan = (bounds: number[], fps: number) => buildDeterministicRenderPlan({
  width: 320, height: 180, fps, audioDurationMs: bounds[bounds.length - 1],
  audioSourceUrl: "https://signed.example/audio", visualItems: gridVisuals(bounds), captions: [],
  subtitlePath: "/tmp/grid.srt", outputPath: "/tmp/grid.mp4",
});
const nonAligned = [0, 1337, 2500, 4111, 6000];

describe("Creator render plan global frame grid", () => {
  it("plans the canonical non-frame-aligned timeline on one grid at 24 and 30 fps", () => {
    const at24 = gridPlan(nonAligned, 24);
    expect(at24.frameCount).toBe(144);
    expect(at24.frameSegments.map(({ startFrame, endFrame, frameCount }) => [startFrame, endFrame, frameCount]))
      .toEqual([[0, 32, 32], [32, 60, 28], [60, 99, 39], [99, 144, 45]]);
    const at30 = gridPlan(nonAligned, 30);
    expect(at30.frameCount).toBe(180);
    expect(at30.frameSegments.map(({ startFrame, endFrame, frameCount }) => [startFrame, endFrame, frameCount]))
      .toEqual([[0, 40, 40], [40, 75, 35], [75, 123, 48], [123, 180, 57]]);
  });

  it.each([
    [nonAligned, 24], [nonAligned, 30], [nonAligned, 25], [nonAligned, 60],
    [[0, 41, 83, 125, 166, 208], 24], [[0, 1, 2, 3, 100], 24], [[0, 333, 667, 1000], 30],
    [[0, 1000, 2000], 24], [[0, 1500, 3000], 24], [[0, 17, 34, 51, 68, 85, 102, 119, 136, 153, 170], 60],
  ] as Array<[number[], number]>)("tiles %j at %i fps with exact shared boundaries", (bounds, fps) => {
    const plan = gridPlan(bounds, fps);
    const segments = plan.frameSegments;
    expect(segments[0].startFrame).toBe(0);
    segments.forEach((segment, index) => {
      expect(segment.frameCount).toBeGreaterThanOrEqual(0);
      expect(segment.frameCount).toBe(segment.endFrame - segment.startFrame);
      expect(segment.startFrame).toBe(frameAtMs(bounds[index], fps));
      expect(segment.endFrame).toBe(frameAtMs(bounds[index + 1], fps));
      if (index > 0) expect(segment.startFrame).toBe(segments[index - 1].endFrame);
    });
    expect(segments[segments.length - 1].endFrame).toBe(plan.frameCount);
    expect(segments.reduce((sum, segment) => sum + segment.frameCount, 0)).toBe(plan.frameCount);
    expect(plan.frameCount).toBe(frameAtMs(bounds[bounds.length - 1], fps));
  });

  it("drives FFmpeg by frame counts, not independently rounded decimal seconds", () => {
    const args = gridPlan(nonAligned, 24).ffmpegArgs.join(" ");
    for (const frames of [32, 28, 39, 45]) expect(args).toContain(`trim=end_frame=${frames},setpts=PTS-STARTPTS`);
    expect(args).not.toContain("trim=duration");
    expect(args).toContain("concat=n=4:v=1:a=0,setpts=N/(24*TB)[vc]");
  });

  it("keeps the aligned fixture's frame count and lists zero-frame segments without rendering them", () => {
    expect(gridPlan([0, 1500, 3000], 24).frameCount).toBe(72);
    const plan = gridPlan([0, 1, 2, 3, 100], 24);
    expect(plan.frameCount).toBe(2);
    expect(plan.visualAssetIds).toEqual([200, 201, 202, 203]);
    expect(plan.frameSegments.map(segment => segment.frameCount)).toEqual([0, 0, 0, 2]);
    expect(plan.ffmpegArgs.filter(arg => arg === "-loop")).toHaveLength(1);
    expect(plan.ffmpegArgs.join(" ")).toContain("concat=n=1:v=1:a=0");
  });

  it("refuses a master too short to occupy one frame at the target fps", () => {
    expect(() => gridPlan([0, 10], 24)).toThrow("CREATOR_RENDER_DURATION_TOO_SHORT_FOR_FPS");
  });
});

describe.skipIf(!canProbe)("Creator real FFmpeg frame-count acceptance (global frame grid)", () => {
  const colors = ["204060", "406080", "608040", "804060", "a06040", "60a040"];
  const renderGrid = async (bounds: number[], fps: number, clipSeconds: Record<number, number> = {}) => {
    const dir = mkdtempSync(join(tmpdir(), "creator-grid-"));
    try {
      const total = bounds[bounds.length - 1];
      const audio = join(dir, "audio.wav");
      const subtitle = join(dir, "captions.srt");
      const output = join(dir, "candidate.mp4");
      execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi",
        "-i", `sine=frequency=440:sample_rate=48000:duration=${total / 1000}`, "-c:a", "pcm_s16le", audio], { timeout: 15_000 });
      const visualItems = gridVisuals(bounds).map((item, index) => {
        const still = join(dir, `still-${index}.png`);
        execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi",
          "-i", `color=c=0x${colors[index % colors.length]}:s=320x180`, "-frames:v", "1", still], { timeout: 15_000 });
        if (clipSeconds[index] === undefined) return { ...item, sourceUrl: still };
        const clip = join(dir, `clip-${index}.mp4`);
        execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi",
          "-i", `testsrc=s=320x180:r=${fps}:d=${clipSeconds[index]}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", clip], { timeout: 30_000 });
        return { ...item, assetType: "VIDEO" as const, sourceUrl: clip };
      });
      const plan = buildDeterministicRenderPlan({
        width: 320, height: 180, fps, audioDurationMs: total, audioSourceUrl: audio, visualItems,
        captions: [{ startMs: 0, endMs: total, text: "cue", language: "en", locked: true }],
        subtitlePath: subtitle, outputPath: output,
      });
      writeFileSync(subtitle, plan.srt, "utf8");
      execFileSync("ffmpeg", plan.ffmpegArgs, { timeout: 60_000, stdio: "pipe" });
      const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0",
        "-show_entries", "stream=nb_frames,nb_read_frames", "-of", "json", output], { encoding: "utf8", timeout: 15_000 })) as {
        streams: Array<{ nb_frames: string; nb_read_frames: string }>;
      };
      const target = { width: 320, height: 180, fps, durationSeconds: total / 1000, hasAudio: true };
      const probeError = await probeCreatorRenderedOutput(output, target).then(() => undefined, (error: Error) => error.message);
      return { plan, decoded: Number(probe.streams[0].nb_read_frames), declared: Number(probe.streams[0].nb_frames), probeError };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it.each([
    [nonAligned, 24, 144],
    [nonAligned, 30, 180],
    [[0, 41, 83, 125, 166, 208], 24, 5],
    [[0, 1, 2, 3, 100], 24, 2],
    [[0, 333, 667, 1000], 24, 24],
    [[0, 1000, 2000], 24, 48],
  ] as Array<[number[], number, number]>)("renders %j at %i fps as exactly %i decoded frames", async (bounds, fps, expected) => {
    const { plan, decoded, declared, probeError } = await renderGrid(bounds, fps);
    expect(plan.frameCount).toBe(expected);
    expect(decoded).toBe(plan.frameCount);
    expect(declared).toBe(plan.frameCount);
    expect(probeError).toBeUndefined();
  }, 120_000);

  it("renders VIDEO segments exactly when the clip covers its slot, even when resampled from another fps", async () => {
    const { plan, decoded, probeError } = await renderGrid([0, 1337, 3000], 24, { 1: 3 });
    expect(plan.frameCount).toBe(72);
    expect(decoded).toBe(72);
    expect(probeError).toBeUndefined();
  }, 120_000);

  it("fails closed instead of shipping a master when a VIDEO clip is shorter than its timeline slot", async () => {
    // A 1 s clip in a 1.663 s slot decodes only 56 of 72 frames while the audio still runs the full master.
    const { plan, decoded, probeError } = await renderGrid([0, 1337, 3000], 24, { 1: 1 });
    expect(plan.frameCount).toBe(72);
    expect(decoded).toBeLessThan(plan.frameCount);
    expect(probeError).toBe("CREATOR_RENDER_OUTPUT_NONCONFORMANT:video_frames");
  }, 120_000);
});
