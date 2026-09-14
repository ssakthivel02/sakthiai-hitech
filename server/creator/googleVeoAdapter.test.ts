import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyGoogleVeoFailure,
  extractGoogleVeoArtifacts,
  fetchGoogleVeoArtifact,
  googleVeoProvider,
  validateGoogleVeoDownloadUri,
} from "./googleVeoAdapter";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.GEMINI_API_KEY;
});

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

  it("accepts only HTTPS Google API artifact hosts", () => {
    expect(validateGoogleVeoDownloadUri("https://generativelanguage.googleapis.com/v1beta/files/test:download").hostname).toBe(
      "generativelanguage.googleapis.com",
    );
    expect(validateGoogleVeoDownloadUri("https://storage.googleapis.com/example/video.mp4").hostname).toBe("storage.googleapis.com");
    expect(() => validateGoogleVeoDownloadUri("http://generativelanguage.googleapis.com/video.mp4")).toThrow(
      "CREATOR_VEO_ARTIFACT_URI_INVALID",
    );
    expect(() => validateGoogleVeoDownloadUri("https://example.invalid/video.mp4")).toThrow(
      "CREATOR_VEO_ARTIFACT_HOST_INVALID",
    );
  });

  it("fails closed instead of automatically following artifact redirects", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    const fetchMock = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      expect(init?.redirect).toBe("error");
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "video/mp4" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchGoogleVeoArtifact({
      mimeType: "video/mp4",
      uri: "https://generativelanguage.googleapis.com/v1beta/files/test:download",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.mimeType).toBe("video/mp4");
    expect(Array.from(result.data)).toEqual([1, 2, 3]);
  });
});
