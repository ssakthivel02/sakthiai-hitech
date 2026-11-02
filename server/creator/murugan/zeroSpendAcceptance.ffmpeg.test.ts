import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assembleWavParts, makePcmWav } from "../speech/wav";
import { buildDeterministicRenderPlan } from "../renderPlan";
import { resolveCreatorCaptionFonts } from "../renderWorker";
import { buildScenePlan } from "./scenePlan";
import { buildCaptionCues, verifyCaptionsMatchSource } from "./captions";
import { contiguousVisualWindows } from "./sync";

const ffmpegOk = spawnSync("ffmpeg", ["-version"]).status === 0 && /enable-libass/.test(spawnSync("ffmpeg", ["-hide_banner", "-buildconf"], { encoding: "utf8" }).stdout ?? "");

describe("contiguous visual windows", () => {
  it("splits silent gaps at their midpoint and covers the whole master", () => {
    const w = contiguousVisualWindows([{ id: "a", startMs: 100, endMs: 1000 }, { id: "b", startMs: 1400, endMs: 2000 }], 2200);
    expect(w).toEqual([{ id: "a", startMs: 0, endMs: 1200 }, { id: "b", startMs: 1200, endMs: 2200 }]);
    expect(() => contiguousVisualWindows([{ id: "a", startMs: 0, endMs: 3000 }], 2000)).toThrow("SYNC_WINDOW_OUTSIDE_AUDIO");
    expect(() => contiguousVisualWindows([{ id: "a", startMs: 0, endMs: 1000 }, { id: "b", startMs: 900, endMs: 2000 }], 2000)).toThrow("SYNC_WINDOW_INVALID:b");
  });
});

/**
 * ZERO-SPEND runtime acceptance of everything after generation: audio assembly -> exact timings -> plan -> Tamil caption
 * cues (human lock simulated) -> deterministic render with the pinned Tamil font -> decodable 16:9 master whose duration
 * matches the audio master. Audio is SYNTHETIC tone and visuals are PLACEHOLDER stills: this proves the pipeline, not
 * Murugan imagery, not Tamil speech quality and not provider output.
 */
describe.skipIf(!ffmpegOk)("zero-spend render acceptance (real ffmpeg, synthetic audio, placeholder visuals)", () => {
  it("renders a locked-caption master whose duration equals the audio master", () => {
    const dir = mkdtempSync(join(tmpdir(), "murugan-zero-spend-"));
    try {
      const approved = [
        ["L1", "முருகா முருகா வேலா வேலா", 4200], ["L2", "கந்தா கடம்பா கார்த்திகேயா சரவணா", 6100],
        ["L3", "வெற்றி வேல் முருகனுக்கு அரோகரா", 5300], ["L4", "ஆறுமுகா ஆறுபடை வீடு கொண்டவா", 5000], ["L5", "பழனி மலை வாழும் பாலகா", 4400],
      ] as const;
      const assembled = assembleWavParts(approved.map(([id, , ms]) => ({ id, wav: makePcmWav(ms, 24_000, 3000) })), 300);
      writeFileSync(join(dir, "master.wav"), assembled.wav);
      const windows = contiguousVisualWindows(assembled.timings, assembled.durationMs);

      const plan = buildScenePlan({
        projectName: "zero-spend acceptance", audio: { sha256: "c".repeat(64), durationMs: assembled.durationMs },
        referenceAssetIds: ["ref-1"],
        lines: approved.map(([id], i) => ({ lineId: id, startMs: windows[i].startMs, endMs: windows[i].endMs, subject: "Murugan at the shrine", action: "stands calmly", environment: "a hill temple", elements: ["murugan"] })),
      });

      const captionLines = approved.map(([id, text], i) => ({ lineId: id, startMs: assembled.timings[i].startMs, endMs: assembled.timings[i].endMs, textTa: text }));
      const built = buildCaptionCues(captionLines, assembled.durationMs);
      expect(verifyCaptionsMatchSource(built.cues, captionLines)).toEqual([]);
      const locked = built.cues.map(({ lineId: _lineId, ...cue }) => ({ ...cue, locked: true }));

      const visualItems = plan.shots.map((shot, i) => {
        const png = join(dir, `shot-${i}.png`);
        execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=c=0x${(0x203040 + i * 0x101010).toString(16)}:s=640x360:d=1`, "-frames:v", "1", png]);
        return { assetId: i + 1, shotId: i + 1, assetType: "IMAGE" as const, sourceUrl: png, startMs: shot.startMs, endMs: shot.endMs, track: 1, sortOrder: i, approved: true };
      });

      const out = join(dir, "master-16x9.mp4");
      const renderPlan = buildDeterministicRenderPlan({
        width: 640, height: 360, fps: 24, audioDurationMs: assembled.durationMs, audioSourceUrl: join(dir, "master.wav"),
        visualItems, captions: locked, subtitlePath: join(dir, "captions.ta.srt"), outputPath: out, captionFonts: resolveCreatorCaptionFonts({}),
      });
      writeFileSync(join(dir, "captions.ta.srt"), renderPlan.srt, "utf8");
      const run = spawnSync("ffmpeg", renderPlan.ffmpegArgs, { encoding: "utf8" });
      expect(run.status).toBe(0);

      const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height", "-of", "json", out], { encoding: "utf8" }));
      expect(Math.abs(Number(probe.format.duration) * 1000 - assembled.durationMs)).toBeLessThan(80);
      expect(probe.streams.some((s: { codec_type: string; width?: number; height?: number }) => s.codec_type === "video" && s.width === 640 && s.height === 360)).toBe(true);
      expect(probe.streams.some((s: { codec_type: string }) => s.codec_type === "audio")).toBe(true);

      // A frame inside the first spoken line must carry caption pixels in the bottom band; a frame in the first silent gap must not.
      const bandMax = (atSeconds: number) => {
        const raw = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-ss", String(atSeconds), "-i", out, "-frames:v", "1", "-vf", "crop=640:70:0:290,format=gray", "-f", "rawvideo", "-"], { maxBuffer: 1 << 20 });
        return Math.max(...raw);
      };
      expect(bandMax(2)).toBeGreaterThan(200);
      expect(bandMax(4.35)).toBeLessThan(120);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
