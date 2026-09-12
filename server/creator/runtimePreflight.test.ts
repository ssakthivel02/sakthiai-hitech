import { afterEach, describe, expect, it } from "vitest";
import { buildCreatorRuntimePreflight } from "./runtimePreflight";

const originalGeminiApiKey = process.env.GEMINI_API_KEY;

afterEach(() => {
  if (originalGeminiApiKey === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = originalGeminiApiKey;
});

describe("Creator runtime preflight", () => {
  it("never implies production approval", () => {
    const result = buildCreatorRuntimePreflight({ ffmpegProbe: { pass: true, detail: "ffmpeg version test" } });
    expect(result.productionApproved).toBe(false);
  });

  it("returns bounded, secret-free check metadata", () => {
    const result = buildCreatorRuntimePreflight({ ffmpegProbe: { pass: false, detail: "FFmpeg executable is not available to the Creator render worker." } });
    expect(result.checks.map(check => check.id)).toEqual([
      "DATABASE_CONFIGURED",
      "STORAGE_CONFIGURED",
      "IMAGE_PROVIDER_CONFIGURED",
      "VIDEO_PROVIDER_CONFIGURED",
      "FFMPEG_AVAILABLE",
    ]);
    expect(result.readyForPaidGeneration).toBe(false);
    expect(JSON.stringify(result)).not.toContain("GEMINI_API_KEY");
    expect(JSON.stringify(result)).not.toContain("STORAGE_SECRET_ACCESS_KEY");
  });

  it("recognizes the configured Gemini image provider used by the Creator adapter", () => {
    process.env.GEMINI_API_KEY = "creator-runtime-preflight-test-key";

    const result = buildCreatorRuntimePreflight({ ffmpegProbe: { pass: true, detail: "ffmpeg version test" } });
    const imageProvider = result.checks.find(check => check.id === "IMAGE_PROVIDER_CONFIGURED");

    expect(imageProvider?.pass).toBe(true);
    expect(imageProvider?.detail).toContain("gemini-3.1-flash-image");
  });
});
