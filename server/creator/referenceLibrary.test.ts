import { describe, expect, it } from "vitest";
import { validateShotTiming } from "./referenceLibrary";

describe("Creator reference library / shot timing", () => {
  it("accepts a bounded positive shot interval", () => {
    expect(validateShotTiming(0, 8000)).toEqual({ startMs: 0, endMs: 8000 });
  });

  it.each([
    [-1, 1000],
    [1000, 1000],
    [2000, 1000],
    [1.5, 2000],
  ])("rejects invalid shot timing %s-%s", (startMs, endMs) => {
    expect(() => validateShotTiming(startMs, endMs)).toThrow("CREATOR_SHOT_TIME_RANGE_INVALID");
  });
});
