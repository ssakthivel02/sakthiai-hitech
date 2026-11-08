import { describe, expect, it } from "vitest";
import {
  assertCreatorJobTransition,
  canTransitionCreatorJob,
  isCreatorTerminalState,
} from "./types";

describe("SakthiAI Creator durable job state contract", () => {
  it("allows the normal queued to running to succeeded path", () => {
    expect(canTransitionCreatorJob("QUEUED", "SUBMITTED")).toBe(true);
    expect(canTransitionCreatorJob("SUBMITTED", "RUNNING")).toBe(true);
    expect(canTransitionCreatorJob("RUNNING", "SUCCEEDED")).toBe(true);
  });

  it("supports bounded artifact persistence recovery without reopening execution", () => {
    expect(canTransitionCreatorJob("RUNNING", "RETRYABLE")).toBe(true);
    expect(canTransitionCreatorJob("SUCCEEDED", "RETRYABLE")).toBe(true);
    expect(canTransitionCreatorJob("RETRYABLE", "SUCCEEDED")).toBe(true);
    expect(canTransitionCreatorJob("RETRYABLE", "QUEUED")).toBe(true);
    expect(canTransitionCreatorJob("SUCCEEDED", "QUEUED")).toBe(false);
    expect(canTransitionCreatorJob("SUCCEEDED", "RUNNING")).toBe(false);
    expect(() => assertCreatorJobTransition("SUCCEEDED", "RUNNING")).toThrow(
      "CREATOR_INVALID_JOB_TRANSITION_SUCCEEDED_TO_RUNNING",
    );
  });

  it("treats success, failure and cancellation as terminal for externally visible execution", () => {
    expect(isCreatorTerminalState("SUCCEEDED")).toBe(true);
    expect(isCreatorTerminalState("FAILED")).toBe(true);
    expect(isCreatorTerminalState("CANCELLED")).toBe(true);
    expect(isCreatorTerminalState("RETRYABLE")).toBe(false);
  });
});
