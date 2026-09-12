import { describe, expect, it } from "vitest";
import { buildDeterministicRenderPlan, serializeSrt } from "./renderPlan";

const captions = [
  { startMs: 0, endMs: 1500, text: "முருகா...", language: "ta" as const, locked: true },
  { startMs: 1500, endMs: 3000, text: "என் முருகா...", language: "ta" as const, locked: true },
];

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
    });

    expect(plan.visualAssetIds).toEqual([11, 12]);
    expect(plan.frameCount).toBe(72);
    expect(plan.durationMs).toBe(3000);
    expect(plan.ffmpegArgs).toContain("libx264");
    expect(plan.ffmpegArgs).toContain("320k");
    expect(plan.ffmpegArgs.at(-1)).toBe("/tmp/master.mp4");
    expect(plan.ffmpegArgs.join(" ")).toContain("concat=n=2:v=1:a=0");
    expect(plan.ffmpegArgs.join(" ")).toContain("subtitles='/tmp/creator-ta.srt':charenc=UTF-8");
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

  it("rejects unlocked or overlapping captions", () => {
    expect(() => serializeSrt([{ ...captions[0], locked: false }], 3000)).toThrow("CREATOR_RENDER_CAPTION_NOT_LOCKED");
    expect(() => serializeSrt([captions[0], { ...captions[1], startMs: 1400 }], 3000)).toThrow("CREATOR_RENDER_CAPTION_OVERLAP");
  });
});
