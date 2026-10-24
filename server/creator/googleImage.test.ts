import { describe, expect, it } from "vitest";
import {
  buildGoogleImagePayload,
  classifyGoogleImageFailure,
  extractGoogleImageArtifacts,
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
});
