import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyGoogleVeoFailure,
  extractGoogleVeoArtifacts,
  fetchGoogleVeoArtifact,
  googleVeoProvider,
  validateGoogleVeoDownloadUri,
  readBoundedGoogleVeoBody,
  validateGoogleVeoMp4Signature,
} from "./googleVeoAdapter";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.GEMINI_API_KEY;
});

describe("Google Veo provider-neutral Creator adapter", () => {
  it("rejects credential-bearing and nonstandard-port artifact URLs before sending API keys", () => {
    for (const uri of [
      "https://user@generativelanguage.googleapis.com/v1beta/files/a",
      "https://user:password@generativelanguage.googleapis.com/v1beta/files/a",
      "https://generativelanguage.googleapis.com:8443/v1beta/files/a",
      "http://generativelanguage.googleapis.com/v1beta/files/a",
    ]) {
      expect(() => validateGoogleVeoDownloadUri(uri)).toThrow("CREATOR_VEO_ARTIFACT_URI_INVALID");
    }
    expect(validateGoogleVeoDownloadUri("https://generativelanguage.googleapis.com/v1beta/files/a").hostname)
      .toBe("generativelanguage.googleapis.com");
  });

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


  it("assembles chunked Veo output without requiring Content-Length", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3, 4, 5]));
        controller.close();
      },
    });
    const data = await readBoundedGoogleVeoBody(new Response(stream), 5);
    expect(Array.from(data)).toEqual([1, 2, 3, 4, 5]);
  });

  it("cancels unknown-length streams as soon as the byte budget is exceeded", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5]));
      },
      cancel() { cancelled = true; },
    });
    await expect(readBoundedGoogleVeoBody(new Response(stream), 4)).rejects.toThrow(
      "CREATOR_VEO_ARTIFACT_TOO_LARGE",
    );
    expect(cancelled).toBe(true);
  });

  it("rejects oversized declared lengths before accepting media bytes", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel() { cancelled = true; },
    });
    await expect(readBoundedGoogleVeoBody(new Response(stream, {
      headers: { "content-length": "9" },
    }), 4)).rejects.toThrow("CREATOR_VEO_ARTIFACT_TOO_LARGE");
    expect(cancelled).toBe(true);
  });

  it("rejects malformed, truncated and contradictory Content-Length evidence", async () => {
    await expect(readBoundedGoogleVeoBody(new Response(new Uint8Array([1]), {
      headers: { "content-length": "-1" },
    }), 4)).rejects.toThrow("CREATOR_VEO_ARTIFACT_LENGTH_INVALID");
    await expect(readBoundedGoogleVeoBody(new Response(new Uint8Array([1, 2]), {
      headers: { "content-length": "3" },
    }), 4)).rejects.toThrow("CREATOR_VEO_ARTIFACT_LENGTH_MISMATCH");
    await expect(readBoundedGoogleVeoBody(new Response(new Uint8Array([1, 2]), {
      headers: { "content-length": "1" },
    }), 4)).rejects.toThrow("CREATOR_VEO_ARTIFACT_LENGTH_MISMATCH");
  });

  it("rejects empty bodies and invalid test limits", async () => {
    await expect(readBoundedGoogleVeoBody(new Response(new Uint8Array()), 4)).rejects.toThrow(
      "CREATOR_VEO_ARTIFACT_EMPTY",
    );
    await expect(readBoundedGoogleVeoBody(new Response(new Uint8Array([1])), 0)).rejects.toThrow(
      "CREATOR_VEO_ARTIFACT_LIMIT_INVALID",
    );
  });

  it("rejects a successful HTML response rather than persisting it as video", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>upstream error</html>", {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    })));
    await expect(fetchGoogleVeoArtifact({
      mimeType: "video/mp4",
      uri: "https://generativelanguage.googleapis.com/v1beta/files/test:download",
    })).rejects.toThrow("CREATOR_VEO_ARTIFACT_MIME_INVALID");
  });

  it("rejects a successful response with no Content-Type rather than relabelling unknown bytes as video", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]), {
      status: 200,
    })));
    await expect(fetchGoogleVeoArtifact({
      mimeType: "video/mp4",
      uri: "https://generativelanguage.googleapis.com/v1beta/files/test:download",
    })).rejects.toThrow("CREATOR_VEO_ARTIFACT_MIME_INVALID");
  });

  it("rejects spoofed video/mp4 responses whose bytes are not an MP4 ftyp container", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new TextEncoder().encode("not-an-mp4-payload"), {
      status: 200,
      headers: { "content-type": "video/mp4" },
    })));
    await expect(fetchGoogleVeoArtifact({
      mimeType: "video/mp4",
      uri: "https://generativelanguage.googleapis.com/v1beta/files/test:download",
    })).rejects.toThrow("CREATOR_VEO_ARTIFACT_FORMAT_INVALID");
  });

  it("accepts a structurally valid minimal ftyp box signature", () => {
    const minimalFtyp = new Uint8Array([
      0x00, 0x00, 0x00, 0x10,
      0x66, 0x74, 0x79, 0x70,
      0x69, 0x73, 0x6f, 0x6d,
      0x00, 0x00, 0x00, 0x00,
    ]);
    expect(() => validateGoogleVeoMp4Signature(minimalFtyp)).not.toThrow();
  });

  it("fails closed instead of automatically following artifact redirects", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    const fetchMock = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      expect(init?.redirect).toBe("error");
      const response = new Response(new Uint8Array([
        0x00, 0x00, 0x00, 0x10,
        0x66, 0x74, 0x79, 0x70,
        0x69, 0x73, 0x6f, 0x6d,
        0x00, 0x00, 0x00, 0x00,
      ]), {
        status: 200,
        headers: { "content-type": "video/mp4" },
      });
      // The provider must use the bounded streaming reader, never arrayBuffer().
      Object.defineProperty(response, "arrayBuffer", {
        value: () => { throw new Error("UNBOUNDED_ARRAYBUFFER_FORBIDDEN"); },
      });
      return response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchGoogleVeoArtifact({
      mimeType: "video/mp4",
      uri: "https://generativelanguage.googleapis.com/v1beta/files/test:download",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.mimeType).toBe("video/mp4");
    expect(Array.from(result.data.slice(4, 8))).toEqual([0x66, 0x74, 0x79, 0x70]);
  });
});
