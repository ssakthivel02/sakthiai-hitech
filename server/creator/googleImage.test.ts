import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildGoogleImagePayload,
  classifyGoogleImageFailure,
  extractGoogleImageArtifacts,
  decodeGoogleImageArtifact,
  fetchGoogleImageArtifact,
  readBoundedGoogleImageBody,
  validateGoogleImageArtifactUri,
} from "./googleImage";

describe("Google Gemini image Creator adapter", () => {
  it("builds a provider request for a 16:9 Murugan keyframe without leaking UI logic", () => {
    const result = buildGoogleImagePayload({
      kind: "IMAGE",
      prompt: "Cinematic devotional Murugan keyframe",
      aspectRatio: "16:9",
      imageSize: "2K",
    });
    expect(result.model).toBe("gemini-3.1-flash-image");
    expect(result.body.response_format).toMatchObject({ type: "image", aspect_ratio: "16:9", image_size: "2K" });
  });

  it("requires a source reference for image editing", () => {
    expect(() => buildGoogleImagePayload({ kind: "IMAGE_EDIT", prompt: "Preserve identity and change lighting" })).toThrow(
      "CREATOR_IMAGE_EDIT_REQUIRES_REFERENCE",
    );
  });

  it("extracts REST interaction image artifacts from model_output steps", () => {
    const artifacts = extractGoogleImageArtifacts({
      status: "completed",
      steps: [{ type: "model_output", content: [{ type: "image", mime_type: "image/png", data: "aGVsbG8=" }] }],
    });
    expect(artifacts).toEqual([{ mimeType: "image/png", dataBase64: "aGVsbG8=", uri: undefined }]);
  });

  it("does not label an ordinary unknown error as an authenticated provider", () => {
    expect(classifyGoogleImageFailure(new Error("unexpected"))).toBe("UNKNOWN");
  });
  it("decodes a canonical inline image and accepts a matching data URI", () => {
    const artifact = decodeGoogleImageArtifact({ mimeType: "image/png", dataBase64: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC" });
    expect(artifact.mimeType).toBe("image/png");
    expect(Buffer.from(artifact.data).subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  });

  it("rejects noncanonical, malformed, and mismatched data-URI image payloads", () => {
    expect(() => decodeGoogleImageArtifact({ mimeType: "image/png", dataBase64: "Zh==" })).toThrow(
      "CREATOR_IMAGE_INVALID_BASE64",
    );
    expect(() => decodeGoogleImageArtifact({ mimeType: "image/png", dataBase64: "aGVsbG8" })).toThrow(
      "CREATOR_IMAGE_INVALID_BASE64",
    );
    expect(() => decodeGoogleImageArtifact({ mimeType: "image/png", dataBase64: "data:image/jpeg;base64,aGVsbG8=" })).toThrow(
      "CREATOR_IMAGE_MIME_MISMATCH",
    );
    expect(() => decodeGoogleImageArtifact({ mimeType: "text/html", dataBase64: "aGVsbG8=" })).toThrow(
      "CREATOR_IMAGE_MIME_UNSUPPORTED",
    );
    expect(() => decodeGoogleImageArtifact({ mimeType: "image/png", dataBase64: "data:text/html;base64,aGVsbG8=" })).toThrow(
      "CREATOR_IMAGE_MIME_MISMATCH",
    );
  });

  it("rejects oversized encoded data before decoding an 8 MiB image", () => {
    expect(() => decodeGoogleImageArtifact({
      mimeType: "image/png",
      dataBase64: "A".repeat(Math.ceil((8 * 1024 * 1024) / 3) * 4 + 4),
    })).toThrow("CREATOR_IMAGE_SIZE_INVALID");
  });

  it("validates reference-image MIME against the supplied data URI", () => {
    expect(() => buildGoogleImagePayload({
      kind: "IMAGE_EDIT",
      prompt: "Preserve Murugan reference identity",
      references: [{ mimeType: "image/png", dataBase64: "data:image/jpeg;base64,aGVsbG8=" }],
    })).toThrow("CREATOR_IMAGE_MIME_MISMATCH");
  });

});


describe("Gemini image artifact transport safety", () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64");
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("rejects non-image bytes even when Base64 and the claimed MIME are valid", () => {
    expect(() => decodeGoogleImageArtifact({ mimeType: "image/png", dataBase64: "aGVsbG8=" }))
      .toThrow("CREATOR_IMAGE_SIGNATURE_MISMATCH");
    expect(() => decodeGoogleImageArtifact({ mimeType: "image/jpeg", dataBase64: png.toString("base64") }))
      .toThrow("CREATOR_IMAGE_SIGNATURE_MISMATCH");
    expect(() => decodeGoogleImageArtifact({ mimeType: "image/png", dataBase64: png.subarray(0, 30).toString("base64") }))
      .toThrow("CREATOR_IMAGE_SIGNATURE_MISMATCH");
  });

  it("accepts only the first-party HTTPS Gemini host before sending credentials", () => {
    expect(validateGoogleImageArtifactUri("https://generativelanguage.googleapis.com/v1beta/files/test").hostname)
      .toBe("generativelanguage.googleapis.com");
    for (const uri of [
      "http://generativelanguage.googleapis.com/v1beta/files/test",
      "https://generativelanguage.googleapis.com.evil.test/x",
      "https://example.com/x",
      "https://user@generativelanguage.googleapis.com/x",
    ]) {
      expect(() => validateGoogleImageArtifactUri(uri)).toThrow("CREATOR_IMAGE_ARTIFACT_URI_INVALID");
    }
  });

  it("downloads and verifies a provider-hosted PNG with redirect handling disabled", async () => {
    vi.stubEnv("GEMINI_API_KEY", "ci-only-gemini-key");
    const mock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array(png), {
        headers: { "content-type": "image/png", "content-length": String(png.length) },
      }),
    );
    const result = await fetchGoogleImageArtifact({
      mimeType: "",
      uri: "https://generativelanguage.googleapis.com/v1beta/files/asset",
    });
    expect(result.mimeType).toBe("image/png");
    expect(Buffer.from(result.data)).toEqual(png);
    expect(mock).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({
      redirect: "error", headers: { "x-goog-api-key": "ci-only-gemini-key" },
    }));
  });

  it("rejects response MIME mismatch and malicious URI without fetching", async () => {
    vi.stubEnv("GEMINI_API_KEY", "ci-only-gemini-key");
    const mock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array(png), { headers: { "content-type": "image/jpeg" } }),
    );
    await expect(fetchGoogleImageArtifact({
      mimeType: "image/png", uri: "https://generativelanguage.googleapis.com/v1beta/files/asset",
    })).rejects.toThrow("CREATOR_IMAGE_MIME_MISMATCH");
    await expect(fetchGoogleImageArtifact({
      mimeType: "image/png", uri: "https://example.com/steal",
    })).rejects.toThrow("CREATOR_IMAGE_ARTIFACT_URI_INVALID");
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("enforces declared and streamed byte limits, and rejects truncated transfers", async () => {
    await expect(readBoundedGoogleImageBody(new Response("abc", {
      headers: { "content-length": "999" },
    }), 8)).rejects.toThrow("CREATOR_IMAGE_ARTIFACT_TOO_LARGE");
    await expect(readBoundedGoogleImageBody(new Response("123456789"), 8))
      .rejects.toThrow("CREATOR_IMAGE_ARTIFACT_TOO_LARGE");
    await expect(readBoundedGoogleImageBody(new Response("abc", {
      headers: { "content-length": "4" },
    }))).rejects.toThrow("CREATOR_IMAGE_ARTIFACT_LENGTH_MISMATCH");
    await expect(readBoundedGoogleImageBody(new Response("abc", {
      headers: { "content-length": "-1" },
    }))).rejects.toThrow("CREATOR_IMAGE_ARTIFACT_LENGTH_INVALID");
  });

  it("preserves URI-only interaction artifacts for bounded retrieval", () => {
    const artifacts = extractGoogleImageArtifacts({
      status: "completed",
      steps: [{ type: "model_output", content: [{
        type: "image", uri: "https://generativelanguage.googleapis.com/v1beta/files/asset",
      }] }],
    });
    expect(artifacts[0]).toMatchObject({ mimeType: "", uri: expect.stringContaining("googleapis.com") });
  });
});
