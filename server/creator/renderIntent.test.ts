import { describe, expect, it } from "vitest";
import { creatorRenderIntentFingerprint, type CreatorRenderIntentInput } from "./renderIntent";

const hash = (char: string) => char.repeat(64);
function fixture(): CreatorRenderIntentInput {
  return {
    workspaceId: 1, creatorProjectId: 2, timelineId: 3,
    mode: "MASTER_CANDIDATE",
    audioMaster: { assetId: 10, checksumSha256: hash("a"), durationMs: 24000 },
    visuals: [
      { assetId: 11, checksumSha256: hash("b"), assetType: "VIDEO", shotId: 21, startMs: 0, endMs: 8000, track: 1, sortOrder: 0 },
      { assetId: 12, checksumSha256: hash("c"), assetType: "VIDEO", shotId: 22, startMs: 8000, endMs: 24000, track: 1, sortOrder: 1 },
    ],
    captions: [{ startMs: 0, endMs: 8000, language: "ta", text: "முருகா வேல்", locked: true }],
    output: { width: 1920, height: 1080, fps: 24, fit: "pad", rendererVersion: "ffmpeg-v1", fontFamily: "Noto Sans Tamil" },
  };
}
const fingerprint = (input: CreatorRenderIntentInput) => creatorRenderIntentFingerprint(input).fingerprint;

describe("Creator render-intent fingerprint (pure; no dispatch or DB claim)", () => {
  it("returns the same 64-character identity for identical source state", () => {
    const first = fingerprint(fixture());
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprint(fixture())).toBe(first);
  });

  it("canonicalizes visual order to match the render-plan sorting contract", () => {
    const reversed = fixture();
    reversed.visuals = [...reversed.visuals].reverse();
    expect(fingerprint(reversed)).toBe(fingerprint(fixture()));
  });

  it("changes on source checksums, shot timing, audio, Tamil text, renderer settings or project scope", () => {
    const original = fingerprint(fixture());
    const variants = [
      (x: CreatorRenderIntentInput) => { x.visuals[0].checksumSha256 = hash("d"); },
      (x: CreatorRenderIntentInput) => { x.visuals[0].endMs = 9000; x.visuals[1].startMs = 9000; },
      (x: CreatorRenderIntentInput) => { x.audioMaster.checksumSha256 = hash("e"); },
      (x: CreatorRenderIntentInput) => { x.captions[0].text = "முருகா சரணம்"; },
      (x: CreatorRenderIntentInput) => { x.output.rendererVersion = "ffmpeg-v2"; },
      (x: CreatorRenderIntentInput) => { x.creatorProjectId = 8; },
    ];
    for (const variant of variants) {
      const changed = fixture(); variant(changed);
      expect(fingerprint(changed)).not.toBe(original);
    }
  });

  it("excludes expiring signed URLs and other unrelated extra properties", () => {
    const first = fixture() as CreatorRenderIntentInput & { signedUrl: string };
    first.signedUrl = "https://example.invalid/media?expires=1";
    const second = fixture() as CreatorRenderIntentInput & { signedUrl: string };
    second.signedUrl = "https://example.invalid/media?expires=2";
    expect(fingerprint(first)).toBe(fingerprint(second));
  });

  it("separates 16:9 master candidates and 9:16 derivatives", () => {
    const masterKey = fingerprint(fixture());
    const derivative = fixture();
    derivative.mode = "VERTICAL_DERIVATIVE";
    derivative.output = { ...derivative.output, width: 1080, height: 1920, fit: "cover" };
    derivative.derivativeOf = { assetId: 101, checksumSha256: hash("f") };
    const derivativeKey = fingerprint(derivative);
    expect(derivativeKey).not.toBe(masterKey);
    derivative.derivativeOf = { assetId: 101, checksumSha256: hash("e") };
    expect(fingerprint(derivative)).not.toBe(derivativeKey);
  });

  it("fails closed on visual gaps, overlaps, invalid hashes, unlocked subtitles and unsafe identifiers", () => {
    const cases = [
      (x: CreatorRenderIntentInput) => { x.visuals[1].startMs = 9000; },
      (x: CreatorRenderIntentInput) => { x.visuals[1].startMs = 7000; },
      (x: CreatorRenderIntentInput) => { x.visuals[0].checksumSha256 = "NOT_SHA256"; },
      (x: CreatorRenderIntentInput) => { x.captions[0].locked = false; },
      (x: CreatorRenderIntentInput) => { x.output.width = 1080; },
      (x: CreatorRenderIntentInput) => { x.visuals[0].shotId = Number.MAX_SAFE_INTEGER + 1; },
    ];
    for (const change of cases) {
      const invalid = fixture(); change(invalid);
      expect(() => fingerprint(invalid)).toThrow();
    }
  });
});
