import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertTimelineShotAttribution, requestedTimelineShotIds } from "./timelineShotAttribution";

const timelineWriter = readFileSync(new URL("./timeline.ts", import.meta.url), "utf8");
const renderService = readFileSync(new URL("./renderService.ts", import.meta.url), "utf8");

describe("Creator scoped timeline shot attribution", () => {
  it("collects distinct positive shot IDs, ignoring optional absent attribution", () => {
    expect(requestedTimelineShotIds([{ shotId: 5 }, {}, { shotId: 5 }, { shotId: null }, { shotId: 11 }]))
      .toEqual([5, 11]);
  });

  it("refuses invalid or unsafe claimed shot identifiers", () => {
    for (const invalid of [-1, 0, 2.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => requestedTimelineShotIds([{ shotId: invalid }])).toThrow("CREATOR_TIMELINE_SHOT_ID_INVALID");
    }
  });

  it("accepts a claimed shot that exists in the same project and matches the asset", () => {
    expect(() => assertTimelineShotAttribution({ shotId: 7 }, { shotId: 7 }, new Set([7]))).not.toThrow();
  });

  it("allows a project-scoped unbound montage asset on a valid shot", () => {
    expect(() => assertTimelineShotAttribution({ shotId: 7 }, { shotId: null }, new Set([7]))).not.toThrow();
    expect(() => assertTimelineShotAttribution({}, { shotId: 7 }, new Set())).not.toThrow();
  });

  it("rejects a shot from another workspace/project even when the asset is shared", () => {
    expect(() => assertTimelineShotAttribution({ shotId: 42 }, { shotId: null }, new Set([7])))
      .toThrow("CREATOR_TIMELINE_SHOT_NOT_FOUND");
  });

  it("rejects a valid claimed shot bound to a different asset shot", () => {
    expect(() => assertTimelineShotAttribution({ shotId: 7 }, { shotId: 8 }, new Set([7, 8])))
      .toThrow("CREATOR_TIMELINE_SHOT_ASSET_MISMATCH");
  });

  it("checks source and pre-render reads with tenant and Creator project scoped shot lookups", () => {
    for (const source of [timelineWriter, renderService]) {
      expect(source).toContain("requestedTimelineShotIds(");
      expect(source).toContain("assertTimelineShotAttribution(");
      expect(source).toContain("eq(creatorShots.workspaceId, input.workspaceId)");
      expect(source).toContain("eq(creatorShots.creatorProjectId, input.creatorProjectId)");
      expect(source).toContain("inArray(creatorShots.id, claimedShotIds)");
    }
  });
});
