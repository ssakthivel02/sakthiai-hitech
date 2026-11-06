import { describe, expect, it } from "vitest";
import { canTransitionCreatorJob } from "./types";

describe("Creator ambiguous submission lifecycle", () => {
  it("allows a queued generation to enter the ambiguity guard before provider submission", () => {
    expect(canTransitionCreatorJob("QUEUED", "SUBMISSION_UNKNOWN")).toBe(true);
  });

  it("allows a persisted provider response to resolve an ambiguous submission", () => {
    expect(canTransitionCreatorJob("SUBMISSION_UNKNOWN", "SUBMITTED")).toBe(true);
    expect(canTransitionCreatorJob("SUBMISSION_UNKNOWN", "RUNNING")).toBe(true);
  });

  it("structurally forbids automatic resubmission from SUBMISSION_UNKNOWN", () => {
    expect(canTransitionCreatorJob("SUBMISSION_UNKNOWN", "QUEUED")).toBe(false);
  });
});
