import { describe, expect, it } from "vitest";
import {
  classifyGoogleVeoFailure,
  extractGoogleVeoArtifacts,
  googleVeoProvider,
} from "./googleVeoAdapter";

describe("Google Veo provider-neutral Creator adapter", () => {
  it("extracts the documented generated video URI from a completed operation", () => {
    const artifacts = extractGoogleVeoArtifacts({
      name: "operations/test",
      done: true,
      response: {
        generateVideoResponse: {
          generatedSamples: [{ video: { uri: "https://generativelanguage.googleapis.com/v1beta/files/test:download", mimeType: "video/mp4" } }],
        },
      },
    });
    expect(artifacts).toEqual([
      { mimeType: "video/mp4", uri: "https://generativelanguage.googleapis.com/v1beta/files/test:download" },
    ]);
  });

  it("keeps video extension disabled until SakthiAI implements the required prior-video contract", () => {
    const status = googleVeoProvider.status();
    expect(status.capabilities.videoExtension).toBe(false);
    expect(googleVeoProvider.supports({ kind: "VIDEO_EXTENSION", prompt: "continue", sourceVideoAssetId: 10 })).toBe(false);
  });

  it("classifies retryable provider failures without pretending they succeeded", () => {
    expect(classifyGoogleVeoFailure(new Error("GOOGLE_VEO_POLL_FAILED_503"))).toBe("PROVIDER_UNAVAILABLE");
    expect(classifyGoogleVeoFailure(new Error("RESOURCE_EXHAUSTED quota"))).toBe("QUOTA");
  });
});
