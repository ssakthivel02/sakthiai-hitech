import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { CREATOR_CAPTION_FONT_FILE, resolveCreatorCaptionFonts, runCreatorRenderWorker } from "./renderWorker";

const renderInput = {
  workspaceId: 1,
  creatorProjectId: 2,
  timelineId: 3,
  exportId: 4,
  width: 1920,
  height: 1080,
  fps: 24,
  audioDurationMs: 2000,
  audioSourceUrl: "https://signed.example/audio",
  visualItems: [
    { assetId: 10, shotId: 20, assetType: "VIDEO" as const, sourceUrl: "https://signed.example/video", startMs: 0, endMs: 2000, track: 1, sortOrder: 0, approved: true },
  ],
  captions: [
    { startMs: 0, endMs: 2000, text: "வேல் முருகா", language: "ta" as const, locked: true },
  ],
};

describe("Creator caption font resolution", () => {
  it("finds the vendored Tamil font from the repository root", () => {
    const fonts = resolveCreatorCaptionFonts({});
    expect(fonts.family).toBe("Noto Sans Tamil");
    expect(fonts.dir.endsWith("/server/creator/fonts")).toBe(true);
  });

  it("honours CREATOR_CAPTION_FONTS_DIR and fails closed when the font file is missing", () => {
    expect(resolveCreatorCaptionFonts({ CREATOR_CAPTION_FONTS_DIR: "/opt/f" }, path => path === `/opt/f/${CREATOR_CAPTION_FONT_FILE}`).dir).toBe("/opt/f");
    expect(() => resolveCreatorCaptionFonts({ CREATOR_CAPTION_FONTS_DIR: "/opt/empty" }, () => false)).toThrow("CREATOR_RENDER_TAMIL_FONT_MISSING");
  });

  it("passes the pinned font to ffmpeg for Tamil captions", async () => {
    const executeFfmpeg = vi.fn(async () => ({ exitCode: 0, stderr: "" }));
    await runCreatorRenderWorker(renderInput, {
      createTempDir: async () => "/tmp/creator-render-font",
      cleanupTempDir: async () => undefined,
      writeSubtitle: async () => undefined,
      readOutput: async () => Buffer.from("x"),
      executeFfmpeg,
      putArtifact: async key => ({ key, url: "/u" }),
      probeOutput: async (_path, expected) => expected,
      verifyArtifact: async () => undefined,
    });
    const args = (executeFfmpeg.mock.calls[0] as unknown as [string[]])[0].join(" ");
    expect(args).toContain("force_style='FontName=Noto Sans Tamil'");
  });
});

describe("Creator render worker", () => {
  it("writes captions, executes ffmpeg and persists a checksummed render", async () => {
    const output = Buffer.from("deterministic-render-fixture");
    const executeFfmpeg = vi.fn(async (args: string[]) => ({ exitCode: 0, stderr: args.join(" ") }));
    const putArtifact = vi.fn(async (key: string) => ({ key: `${key}.stored`, url: "/api/storage/render" }));
    const writeSubtitle = vi.fn(async () => undefined);
    const cleanupTempDir = vi.fn(async () => undefined);

    const result = await runCreatorRenderWorker(renderInput, {
      createTempDir: async () => "/tmp/creator-render-test",
      cleanupTempDir,
      writeSubtitle,
      readOutput: async () => output,
      executeFfmpeg,
      putArtifact,
      probeOutput: async (_path, expected) => expected,
      verifyArtifact: async () => undefined,
    });

    expect(writeSubtitle).toHaveBeenCalledWith("/tmp/creator-render-test/captions.ta.srt", expect.stringContaining("வேல் முருகா"));
    expect(executeFfmpeg).toHaveBeenCalledTimes(1);
    expect(executeFfmpeg.mock.calls[0][0].at(-1)).toBe("/tmp/creator-render-test/master-16x9.mp4");
    expect(putArtifact).toHaveBeenCalledWith("creator/1/2/renders/timeline-3/export-4.mp4", output, "video/mp4");
    expect(result.checksumSha256).toBe(createHash("sha256").update(output).digest("hex"));
    expect(result.frameCount).toBe(48);
    expect(result.visualAssetIds).toEqual([10]);
    expect(cleanupTempDir).toHaveBeenCalledTimes(1);
  });

  it("does not persist output when ffmpeg fails and still cleans up", async () => {
    const putArtifact = vi.fn();
    const cleanupTempDir = vi.fn(async () => undefined);

    await expect(runCreatorRenderWorker(renderInput, {
      createTempDir: async () => "/tmp/creator-render-fail",
      cleanupTempDir,
      writeSubtitle: async () => undefined,
      readOutput: async () => Buffer.from("should-not-read"),
      executeFfmpeg: async () => ({ exitCode: 1, stderr: "codec failure" }),
      putArtifact,
    })).rejects.toThrow("CREATOR_FFMPEG_FAILED:1:codec failure");

    expect(putArtifact).not.toHaveBeenCalled();
    expect(cleanupTempDir).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid ownership identifiers before creating temp state", async () => {
    const createTempDir = vi.fn(async () => "/tmp/should-not-exist");
    await expect(runCreatorRenderWorker({ ...renderInput, workspaceId: 0 }, { createTempDir })).rejects.toThrow("CREATOR_RENDER_ID_INVALID");
    expect(createTempDir).not.toHaveBeenCalled();
  });

  it("fails closed if object storage readback does not match", async () => {
    const cleanupTempDir = vi.fn(async () => undefined);
    const putArtifact = vi.fn(async (key: string) => ({ key, url: "/api/storage/render" }));
    const verifyArtifact = vi.fn(async () => { throw new Error("CREATOR_STORAGE_READBACK_CHECKSUM_MISMATCH"); });
    await expect(runCreatorRenderWorker(renderInput, {
      createTempDir: async () => "/tmp/creator-render-readback-fail",
      cleanupTempDir,
      writeSubtitle: async () => undefined,
      readOutput: async () => Buffer.from("synthetic-render"),
      executeFfmpeg: async () => ({ exitCode: 0, stderr: "" }),
      putArtifact, verifyArtifact,
      probeOutput: async (_path, expected) => expected,
    })).rejects.toThrow("CREATOR_STORAGE_READBACK_CHECKSUM_MISMATCH");
    expect(putArtifact).toHaveBeenCalledTimes(1);
    expect(verifyArtifact).toHaveBeenCalledTimes(1);
    expect(cleanupTempDir).toHaveBeenCalledTimes(1);
  });
  it("refuses to upload an output that FFprobe rejects and cleans temporary files", async () => {
    const putArtifact = vi.fn();
    const cleanupTempDir = vi.fn(async () => undefined);
    await expect(runCreatorRenderWorker(renderInput, {
      createTempDir: async () => "/tmp/creator-probe-fail",
      cleanupTempDir,
      writeSubtitle: async () => undefined,
      executeFfmpeg: async () => ({ exitCode: 0, stderr: "" }),
      probeOutput: async () => { throw new Error("CREATOR_RENDER_OUTPUT_NONCONFORMANT:audio"); },
      readOutput: async () => Buffer.from("invalid"),
      putArtifact,
    })).rejects.toThrow("CREATOR_RENDER_OUTPUT_NONCONFORMANT:audio");
    expect(putArtifact).not.toHaveBeenCalled();
    expect(cleanupTempDir).toHaveBeenCalledTimes(1);
  });

});
