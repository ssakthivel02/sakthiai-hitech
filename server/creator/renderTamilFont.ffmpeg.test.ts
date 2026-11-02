import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildDeterministicRenderPlan } from "./renderPlan";
import { resolveCreatorCaptionFonts } from "./renderWorker";

const ffmpegAvailable = spawnSync("ffmpeg", ["-version"]).status === 0
  && /enable-libass/.test(spawnSync("ffmpeg", ["-hide_banner", "-buildconf"], { encoding: "utf8" }).stdout ?? "");

/**
 * Real FFmpeg/libass acceptance for Tamil captions. Before the Tamil font was pinned, libass asked for "Arial",
 * logged "Glyph 0xBAE not found" for Tamil letters and substituted per glyph, which detached the vowel signs in
 * "முருகா". This runs the production plan and checks libass's own font-selection log.
 */
describe.skipIf(!ffmpegAvailable)("Tamil captions through real ffmpeg (runtime)", () => {
  it("selects the vendored Noto Sans Tamil for every Tamil glyph and writes a decodable master", () => {
    const dir = mkdtempSync(join(tmpdir(), "sakthiai-tamil-font-"));
    try {
      execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=0x203040:s=640x360:d=1", "-frames:v", "1", join(dir, "bg.png")]);
      execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", join(dir, "a.wav")]);
      const plan = buildDeterministicRenderPlan({
        width: 640, height: 360, fps: 25, audioDurationMs: 2000,
        audioSourceUrl: join(dir, "a.wav"),
        visualItems: [{ assetId: 1, assetType: "IMAGE", sourceUrl: join(dir, "bg.png"), startMs: 0, endMs: 2000, approved: true }],
        captions: [{ startMs: 0, endMs: 1900, text: "முருகா வேல் வேல் — ஸ்ரீ கந்தன் க்ஷேத்ரம்", language: "ta", locked: true }],
        subtitlePath: join(dir, "c.srt"),
        outputPath: join(dir, "out.mp4"),
        captionFonts: resolveCreatorCaptionFonts({}),
      });
      writeFileSync(join(dir, "c.srt"), plan.srt, "utf8");
      const args = [...plan.ffmpegArgs];
      args.splice(3, 0, "-loglevel", "verbose");
      const run = spawnSync("ffmpeg", args, { encoding: "utf8" });
      expect(run.status).toBe(0);
      const log = run.stderr;
      expect(log).toMatch(/fontselect: \(Noto Sans Tamil, 400, 0\) -> NotoSansTamil-Regular/);
      const missingTamil = [...log.matchAll(/Glyph 0x([0-9A-Fa-f]+) not found/g)].map(m => parseInt(m[1], 16)).filter(cp => cp >= 0xb80 && cp <= 0xbff);
      expect(missingTamil).toEqual([]);
      const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0", join(dir, "out.mp4")], { encoding: "utf8" });
      expect(probe.stdout).toContain("video");
      expect(probe.stdout).toContain("audio");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
