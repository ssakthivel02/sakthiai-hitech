import { describe, expect, it } from "vitest";
import { extensionForCreatorMimeType } from "./artifactPersistence";
import { canTransitionCreatorJob } from "./types";

describe("Creator artifact persistence contract", () => {
  it("accepts only bounded media MIME types for deterministic storage keys", () => {
    expect(extensionForCreatorMimeType("image/png")).toBe("png");
    expect(extensionForCreatorMimeType("image/jpeg")).toBe("jpg");
    expect(extensionForCreatorMimeType("video/mp4; codecs=avc1")).toBe("mp4");
    expect(() => extensionForCreatorMimeType("text/html")).toThrow("CREATOR_ARTIFACT_MIME_UNSUPPORTED");
  });

  it("allows an artifact retry to resume without buying another provider generation", () => {
    expect(canTransitionCreatorJob("RUNNING", "RETRYABLE")).toBe(true);
    expect(canTransitionCreatorJob("RETRYABLE", "RUNNING")).toBe(true);
  });
});
