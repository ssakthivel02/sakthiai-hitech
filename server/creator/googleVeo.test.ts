import { describe, expect, it } from "vitest";
import { buildVeoPayload, googleVeoStatus, validateVeoRequest } from "./googleVeo";

const image = {
  mimeType: "image/png" as const,
  dataBase64: Buffer.from("creator-test-image").toString("base64"),
};

describe("SAKTHIAI CREATOR Google Veo adapter", () => {
  it("builds a 16:9 8-second first/last-frame request without external dependencies", () => {
    const result = buildVeoPayload({
      prompt: "Locked-camera cinematic Murugan throne test",
      firstFrame: image,
      lastFrame: image,
      resolution: "1080p",
      durationSeconds: 8,
    });

    expect(result.model).toBe("veo-3.1-fast-generate-preview");
    expect(result.body.parameters).toMatchObject({
      numberOfVideos: 1,
      aspectRatio: "16:9",
      durationSeconds: 8,
      resolution: "1080p",
      personGeneration: "allow_adult",
    });
    expect(result.body.instances[0]).toHaveProperty("image");
    expect(result.body.instances[0]).toHaveProperty("lastFrame");
  });

  it("supports up to three immutable reference assets", () => {
    const result = buildVeoPayload({
      prompt: "Preserve the approved character identity",
      referenceImages: [image, image, image],
      durationSeconds: 8,
    });
    const instance = result.body.instances[0] as Record<string, unknown>;
    expect(instance.referenceImages).toHaveLength(3);
  });

  it("rejects invalid last-frame-only requests", () => {
    expect(() => validateVeoRequest({ prompt: "test", lastFrame: image })).toThrow(
      "CREATOR_LAST_FRAME_REQUIRES_FIRST_FRAME",
    );
  });

  it("rejects non-eight-second high-resolution/reference jobs", () => {
    expect(() =>
      validateVeoRequest({ prompt: "test", resolution: "1080p", durationSeconds: 6 }),
    ).toThrow("CREATOR_VEO_REQUIRES_8_SECONDS");
    expect(() =>
      validateVeoRequest({ prompt: "test", referenceImages: [image], durationSeconds: 4 }),
    ).toThrow("CREATOR_VEO_REQUIRES_8_SECONDS");
  });

  it("never reports the provider as configured without a real credential", () => {
    const old = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    expect(googleVeoStatus().configured).toBe(false);
    if (old !== undefined) process.env.GEMINI_API_KEY = old;
  });
});
