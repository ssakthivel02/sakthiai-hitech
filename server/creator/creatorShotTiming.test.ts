import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { isValidCreatorShotTiming } from "../../client/src/lib/creatorShotTiming";

const ui = readFileSync(new URL("../../client/src/pages/Creator.tsx", import.meta.url), "utf8");
const workspaceRouter = readFileSync(new URL("./workspaceRouter.ts", import.meta.url), "utf8");

describe("Creator storyboard shot timing", () => {
  it("accepts exact nonnegative, increasing millisecond intervals", () => {
    expect(isValidCreatorShotTiming(0, 8000)).toBe(true);
    expect(isValidCreatorShotTiming(8000, 16000)).toBe(true);
  });

  it("rejects missing, reversed, fractional and unsafe intervals", () => {
    for (const pair of [
      [-1, 8000], [8000, 8000], [8001, 8000], [0.5, 8000],
      [0, 8000.5], [Number.NaN, 8000], [0, Infinity],
      [0, Number.MAX_SAFE_INTEGER + 1],
    ]) {
      expect(isValidCreatorShotTiming(pair[0], pair[1])).toBe(false);
    }
  });

  it("passes the approved shot boundaries into the existing createShot API", () => {
    expect(ui).toContain("Shot start (ms)");
    expect(ui).toContain("Shot end (ms)");
    expect(ui).toContain("!validShotTiming || createShot.isPending");
    expect(ui).toContain("startMs: shotStartMs, endMs: shotEndMs");
    expect(ui).toContain("setShotStartMs(nextStart)");
    expect(ui).toContain("setShotEndMs(nextStart + 8000)");
    expect(ui).toContain("setShotStartMs(0); setShotEndMs(8000); }, [projectId]");
  });

  it("matches the server contract and existing timed-asset timeline builder", () => {
    expect(workspaceRouter).toContain("startMs: z.number().int().min(0).optional()");
    expect(workspaceRouter).toContain("endMs: z.number().int().positive().optional()");
    expect(workspaceRouter).toContain("CREATOR_SHOT_TIME_RANGE_INVALID");
    expect(ui).toContain("entry.shot.startMs !== null && entry.shot.endMs !== null");
  });
});
