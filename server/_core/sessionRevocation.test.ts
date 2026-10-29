import { describe, expect, it } from "vitest";
import {
  isSessionGenerationCurrent,
  nextSessionGenerationDate,
  sessionGenerationFromDate,
} from "./sessionRevocation";

describe("session revocation generation contract", () => {
  it("normalizes persisted timestamps to database-second precision", () => {
    expect(sessionGenerationFromDate(new Date("2026-09-25T08:00:00.987Z"))).toBe(1790323200);
  });

  it("accepts only the exact persisted generation", () => {
    const persisted = new Date("2026-09-25T08:00:00.000Z");
    expect(isSessionGenerationCurrent(1790323200, persisted)).toBe(true);
    expect(isSessionGenerationCurrent(1790323199, persisted)).toBe(false);
    expect(isSessionGenerationCurrent(1790323201, persisted)).toBe(false);
    expect(isSessionGenerationCurrent(undefined, persisted)).toBe(false);
  });

  it("advances monotonically when security events occur in the same second", () => {
    const previous = new Date("2026-09-25T08:00:00.000Z");
    expect(nextSessionGenerationDate(previous, previous.getTime() + 100).toISOString()).toBe(
      "2026-09-25T08:00:01.000Z",
    );
  });

  it("uses the current second when it is newer than the stored generation", () => {
    const previous = new Date("2026-09-25T08:00:00.000Z");
    expect(
      nextSessionGenerationDate(previous, new Date("2026-09-25T08:00:05.900Z").getTime()).toISOString(),
    ).toBe("2026-09-25T08:00:05.000Z");
  });
});
