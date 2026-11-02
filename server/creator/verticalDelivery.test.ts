import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildDeterministicRenderPlan } from "./renderPlan";
import { resolveCreatorCaptionFonts } from "./renderWorker";
import { assertNoDerivativeDrift, parseApprovedMasterForDerivative } from "./renderService";
import { buildExportManifest } from "./exportManifest";

const base = {
  width: 1080, height: 1920, fps: 24, audioDurationMs: 2000, audioSourceUrl: "a.wav", subtitlePath: "c.srt", outputPath: "o.mp4",
  visualItems: [{ assetId: 1, assetType: "IMAGE" as const, sourceUrl: "i.png", startMs: 0, endMs: 2000, approved: true }],
  captions: [{ startMs: 0, endMs: 1000, text: "Vel", language: "en" as const, locked: true }],
};

describe("render fit", () => {
  it("pad (default) letterboxes; cover fills and centre-crops; anything else is refused", () => {
    expect(buildDeterministicRenderPlan(base).ffmpegArgs.join(" ")).toContain("force_original_aspect_ratio=decrease,pad=1080:1920");
    const cover = buildDeterministicRenderPlan({ ...base, fit: "cover" }).ffmpegArgs.join(" ");
    expect(cover).toContain("force_original_aspect_ratio=increase,crop=1080:1920");
    expect(cover).not.toContain("pad=");
    expect(() => buildDeterministicRenderPlan({ ...base, fit: "stretch" as never })).toThrow("CREATOR_RENDER_FIT_INVALID");
  });
});

describe("9:16 derivative source rules", () => {
  const master = { id: 9, assetType: "RENDER", immutable: 1, reviewDecision: "APPROVED", checksumSha256: "m".repeat(64),
    provenanceJson: JSON.stringify({ source: "deterministic-creator-render", timelineId: 4, visualAssetIds: [1, 2], audioMasterChecksumSha256: "a".repeat(64) }) };
  it("accepts only an approved, immutable 16:9 master of the same timeline", () => {
    expect(parseApprovedMasterForDerivative(master, 4)).toMatchObject({ id: 9, visualAssetIds: [1, 2] });
    expect(() => parseApprovedMasterForDerivative({ ...master, reviewDecision: "PENDING" }, 4)).toThrow("CREATOR_DERIVATIVE_MASTER_NOT_FINAL");
    expect(() => parseApprovedMasterForDerivative({ ...master, assetType: "VIDEO" }, 4)).toThrow("CREATOR_DERIVATIVE_MASTER_NOT_FOUND");
    expect(() => parseApprovedMasterForDerivative(master, 5)).toThrow("CREATOR_DERIVATIVE_TIMELINE_MISMATCH");
    const derivative = { ...master, provenanceJson: JSON.stringify({ source: "deterministic-creator-derivative", timelineId: 4, visualAssetIds: [1, 2], audioMasterChecksumSha256: "a".repeat(64) }) };
    expect(() => parseApprovedMasterForDerivative(derivative, 4)).toThrow("CREATOR_DERIVATIVE_MASTER_NOT_FOUND"); // no derivative of a derivative
  });
  it("refuses if the visuals or the audio master changed since the master was approved", () => {
    const parent = parseApprovedMasterForDerivative(master, 4);
    expect(() => assertNoDerivativeDrift(parent, { visualAssetIds: [1, 2], audioMasterChecksumSha256: "a".repeat(64) })).not.toThrow();
    expect(() => assertNoDerivativeDrift(parent, { visualAssetIds: [2, 1], audioMasterChecksumSha256: "a".repeat(64) })).toThrow("CREATOR_DERIVATIVE_SOURCE_DRIFT");
    expect(() => assertNoDerivativeDrift(parent, { visualAssetIds: [1, 2], audioMasterChecksumSha256: "b".repeat(64) })).toThrow("CREATOR_DERIVATIVE_SOURCE_DRIFT");
  });
});

describe("export provenance manifest", () => {
  const now = new Date("2026-11-02T00:00:00Z");
  const manifest = buildExportManifest({
    exportRow: { id: 3, timelineId: 4, status: "SUCCEEDED", width: 1920, height: 1080, format: "mp4", renderer: "ffmpeg", parametersJson: JSON.stringify({ aspectRatio: "16:9" }), checksumSha256: "r".repeat(64), createdAt: now, completedAt: now },
    renderAsset: { id: 9, checksumSha256: "r".repeat(64), byteSize: 1000, reviewDecision: "APPROVED", immutable: 1, provenanceJson: JSON.stringify({ source: "deterministic-creator-render", durationMs: 2000, frameCount: 48, fps: 24 }) },
    audioMaster: { id: 7, checksumSha256: "a".repeat(64), reviewDecision: "APPROVED" },
    visualAssets: [
      { id: 1, assetType: "VIDEO", checksumSha256: "v".repeat(64), reviewDecision: "APPROVED", immutable: 0, shotId: 11, provenanceJson: JSON.stringify({ generationId: 50, providerJobId: "vid_x", storageKey: "secret/key.mp4" }) },
      { id: 2, assetType: "IMAGE", checksumSha256: "i".repeat(64), reviewDecision: "APPROVED", immutable: 1, shotId: 12, provenanceJson: "{}" },
    ],
    generations: [{ id: 50, kind: "AVATAR_VIDEO", provider: "heygen-avatar", model: "heygen-v2", status: "SUCCEEDED", parametersJson: JSON.stringify({ consentId: 3, providerTestMode: true }) }],
    captions: [{ startMs: 0, endMs: 1000, language: "ta", text: "முருகா", locked: 1 }],
    reviews: [
      { id: 1, assetId: 9, reviewType: "QUALITY", decision: "PASS", reviewerUserId: 5, createdAt: now },
      { id: 2, assetId: 9, reviewType: "HUMAN_TAMIL", decision: "PASS", reviewerUserId: 5, createdAt: now },
      { id: 3, assetId: 9, reviewType: "HUMAN_VISUAL", decision: "REJECT", reviewerUserId: 5, createdAt: now },
    ],
  }, now);

  it("records output, inputs, consent and gate outcomes", () => {
    expect(manifest.output).toMatchObject({ assetId: 9, kind: "MASTER", finalMaster: true });
    expect(manifest.visuals[0].origin).toMatchObject({ type: "GENERATED", kind: "AVATAR_VIDEO", consentId: 3, providerTestMode: true });
    expect(manifest.visuals[1].origin).toEqual({ type: "NOT_GENERATED_HERE" });
    expect(manifest.captions).toMatchObject({ count: 1, locked: true, languages: ["ta"] });
    expect(manifest.gates).toEqual({ quality: true, humanTamil: true, humanVisual: false, publishApproved: false, automaticPublish: false });
  });

  it("never carries storage keys, signed URLs or caption text", () => {
    const text = JSON.stringify(manifest);
    expect(text).not.toContain("secret/key.mp4");
    expect(text).not.toContain("storageKey");
    expect(text).not.toContain("முருகா");
  });
});

const ffmpegOk = spawnSync("ffmpeg", ["-version"]).status === 0 && /enable-libass/.test(spawnSync("ffmpeg", ["-hide_banner", "-buildconf"], { encoding: "utf8" }).stdout ?? "");
describe.skipIf(!ffmpegOk)("9:16 render through real ffmpeg (runtime, synthetic inputs)", () => {
  it("renders a vertical, centre-cropped master with Tamil captions in the pinned font", () => {
    const dir = mkdtempSync(join(tmpdir(), "vertical-"));
    try {
      execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=0x203040:s=640x360:d=1", "-frames:v", "1", join(dir, "bg.png")]);
      execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=330:duration=2", join(dir, "a.wav")]);
      const plan = buildDeterministicRenderPlan({
        ...base, width: 360, height: 640, fit: "cover", audioSourceUrl: join(dir, "a.wav"), subtitlePath: join(dir, "c.srt"), outputPath: join(dir, "o.mp4"),
        visualItems: [{ ...base.visualItems[0], sourceUrl: join(dir, "bg.png") }],
        captions: [{ startMs: 0, endMs: 1900, text: "வெற்றி வேல் முருகனுக்கு அரோகரா", language: "ta", locked: true }],
        captionFonts: resolveCreatorCaptionFonts({}),
      });
      writeFileSync(join(dir, "c.srt"), plan.srt, "utf8");
      const run = spawnSync("ffmpeg", [...plan.ffmpegArgs.slice(0, 3), "-loglevel", "verbose", ...plan.ffmpegArgs.slice(3)], { encoding: "utf8" });
      expect(run.status).toBe(0);
      expect(run.stderr).toMatch(/fontselect: \(Noto Sans Tamil, 400, 0\) -> NotoSansTamil-Regular/);
      const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,width,height:format=duration", "-of", "json", join(dir, "o.mp4")], { encoding: "utf8" }));
      expect(probe.streams.find((s: { codec_type: string }) => s.codec_type === "video")).toMatchObject({ width: 360, height: 640 });
      expect(Math.abs(Number(probe.format.duration) - 2)).toBeLessThan(0.1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
