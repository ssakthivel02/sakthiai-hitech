import { describe, expect, it } from "vitest";
import { buildCreatorRuntimePreflight } from "./runtimePreflight";

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
});
