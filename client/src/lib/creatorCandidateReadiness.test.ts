import { describe, expect, it } from "vitest";
import { creatorCandidateReadiness, type CreatorCandidateReadinessInput } from "./creatorCandidateReadiness";

const sha = "a".repeat(64);
function fixture(): CreatorCandidateReadinessInput {
  return {
    project: { audioMasterAssetId: 1 },
    timeline: { id: 9, audioMasterAssetId: 1, width: 1920, height: 1080, fps: 24 },
    assets: [
      { id: 1, assetType: "AUDIO_MASTER", immutable: 1, reviewDecision: "APPROVED", checksumSha256: sha, provenanceJson: '{"durationMs":2000}' },
      { id: 2, assetType: "IMAGE", immutable: 1, reviewDecision: "APPROVED", checksumSha256: sha, provenanceJson: "{}", shotId: 21 },
      { id: 3, assetType: "VIDEO", immutable: 1, reviewDecision: "APPROVED", checksumSha256: sha, provenanceJson: "{}", shotId: 22 },
    ],
    items: [
      { timelineId: 9, assetId: 2, shotId: 21, startMs: 0, endMs: 1000, track: 1 },
      { timelineId: 9, assetId: 3, shotId: 22, startMs: 1000, endMs: 2000, track: 1 },
    ],
    cues: [
      { timelineId: 9, startMs: 0, endMs: 1000, language: "ta", text: "வேல் முருகா", locked: 1 },
      { timelineId: 9, startMs: 1000, endMs: 2000, language: "ta", text: "அரோகரா", locked: 1 },
    ],
  };
}
describe("Creator candidate UI preflight (server remains authoritative)", () => {
  it("accepts a complete persisted 16:9 / 24fps synthetic snapshot", () => {
    expect(Object.values(creatorCandidateReadiness(fixture())).every(Boolean)).toBe(true);
  });
  it("rejects a revoked or nonimmutable audio master", () => {
    const f = fixture(); f.assets![0].reviewDecision = "REJECTED";
    expect(creatorCandidateReadiness(f).audio).toBe(false);
    f.assets![0].reviewDecision = "APPROVED"; f.assets![0].immutable = 0;
    expect(creatorCandidateReadiness(f).audio).toBe(false);
  });
  it("rejects audio-master pointer drift and malformed duration", () => {
    const f = fixture(); f.timeline!.audioMasterAssetId = 999;
    expect(creatorCandidateReadiness(f).audio).toBe(false);
    f.timeline!.audioMasterAssetId = 1; f.assets![0].provenanceJson = '{"durationMs":"2000"}';
    expect(creatorCandidateReadiness(f).audio).toBe(false);
  });
  it("rejects one revoked visual even when another remains approved", () => {
    const f = fixture(); f.assets![2].reviewDecision = "REJECTED";
    expect(creatorCandidateReadiness(f).visuals).toBe(false);
  });
  it("rejects gaps, overlaps, duplicate assets and partial coverage", () => {
    const f = fixture(); f.items![1].startMs = 1200;
    expect(creatorCandidateReadiness(f).visuals).toBe(false);
    f.items![1].startMs = 900;
    expect(creatorCandidateReadiness(f).visuals).toBe(false);
    f.items![1].startMs = 1000; f.items![1].assetId = 2;
    expect(creatorCandidateReadiness(f).visuals).toBe(false);
    f.items![1].assetId = 3; f.items![1].endMs = 1900;
    expect(creatorCandidateReadiness(f).visuals).toBe(false);
  });
  it("rejects mismatched shot ownership, wrong track and corrupt checksum", () => {
    const f = fixture(); f.items![0].shotId = 22;
    expect(creatorCandidateReadiness(f).visuals).toBe(false);
    f.items![0].shotId = 21; f.items![0].track = 2;
    expect(creatorCandidateReadiness(f).visuals).toBe(false);
    f.items![0].track = 1; f.assets![1].checksumSha256 = "not-sha256";
    expect(creatorCandidateReadiness(f).visuals).toBe(false);
  });
  it("rejects an unlocked or overlapping Tamil cue", () => {
    const f = fixture(); f.cues![1].locked = 0;
    expect(creatorCandidateReadiness(f).tamil).toBe(false);
    f.cues![1].locked = 1; f.cues![1].startMs = 900;
    expect(creatorCandidateReadiness(f).tamil).toBe(false);
  });
  it("requires at least one Tamil cue and rejects foreign-timeline cues", () => {
    const f = fixture(); f.cues![0].language = "en"; f.cues![1].language = "en";
    expect(creatorCandidateReadiness(f).tamil).toBe(false);
    f.cues![0].language = "ta"; f.cues![0].timelineId = 77;
    expect(creatorCandidateReadiness(f).tamil).toBe(false);
  });
  it("rejects an incorrect export profile", () => {
    const f = fixture(); f.timeline!.fps = 30;
    expect(creatorCandidateReadiness(f).profile).toBe(false);
    expect(creatorCandidateReadiness(f).visuals).toBe(false);
  });
  it("rejects missing project, timeline and empty media without throwing", () => {
    expect(Object.values(creatorCandidateReadiness({})).every(v => !v)).toBe(true);
  });
});
