import { describe, expect, it } from "vitest";
import { validateTimelineCoverage } from "./timeline";

describe("Creator visual timeline coverage", () => {
  const items = [
    { assetId: 1, shotId: 101, startMs: 0, endMs: 2000 },
    { assetId: 2, shotId: 102, startMs: 2000, endMs: 5000 },
  ];

  it("normalizes a complete master-aligned sequence", () => {
    expect(validateTimelineCoverage(items, 5000)).toEqual([
      { ...items[0], track: 1, sortOrder: 0 },
      { ...items[1], track: 1, sortOrder: 1 },
    ]);
  });

  it("rejects visual gaps", () => {
    expect(() => validateTimelineCoverage([{ ...items[0], endMs: 1900 }, items[1]], 5000)).toThrow("CREATOR_TIMELINE_GAP");
  });

  it("rejects overlaps", () => {
    expect(() => validateTimelineCoverage([items[0], { ...items[1], startMs: 1900 }], 5000)).toThrow("CREATOR_TIMELINE_OVERLAP");
  });

  it("rejects incomplete master coverage", () => {
    expect(() => validateTimelineCoverage([{ ...items[0], endMs: 5000 }], 6000)).toThrow("CREATOR_TIMELINE_INCOMPLETE_COVERAGE");
  });

  it("rejects duplicate assets and non-primary visual tracks", () => {
    expect(() => validateTimelineCoverage([items[0], { ...items[1], assetId: 1 }], 5000)).toThrow("CREATOR_TIMELINE_DUPLICATE_ASSET");
    expect(() => validateTimelineCoverage([{ ...items[0], track: 2 }, items[1]], 5000)).toThrow("CREATOR_TIMELINE_VISUAL_TRACK_INVALID");
  });
});
