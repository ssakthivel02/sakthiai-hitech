import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { buildDeterministicRenderPlan, captionsNeedTamilFont, type CaptionFonts, type DeterministicRenderPlanInput } from "./renderPlan";
import { storagePut } from "../storage";

export type FfmpegExecution = {
  exitCode: number;
  stderr: string;
};

export type RenderWorkerDependencies = {
  executeFfmpeg?: (args: string[]) => Promise<FfmpegExecution>;
  putArtifact?: (key: string, data: Buffer, contentType: string) => Promise<{ key: string; url: string }>;
  createTempDir?: () => Promise<string>;
  cleanupTempDir?: (path: string) => Promise<void>;
  readOutput?: (path: string) => Promise<Buffer>;
  writeSubtitle?: (path: string, content: string) => Promise<void>;
  captionFonts?: CaptionFonts;
};

export const CREATOR_CAPTION_FONT_FILE = "NotoSansTamil-Regular.ttf";
export const CREATOR_CAPTION_FONT_FAMILY = "Noto Sans Tamil";

/**
 * The vendored OFL Tamil font (server/creator/fonts). Override the directory with CREATOR_CAPTION_FONTS_DIR; the
 * directory must contain CREATOR_CAPTION_FONT_FILE. A missing font is an error, never a silent host-font fallback.
 */
export function resolveCreatorCaptionFonts(
  env: Record<string, string | undefined> = process.env,
  fileExists: (path: string) => boolean = existsSync,
): CaptionFonts {
  const dir = resolve(env.CREATOR_CAPTION_FONTS_DIR?.trim() || join(process.cwd(), "server", "creator", "fonts"));
  if (!fileExists(join(dir, CREATOR_CAPTION_FONT_FILE))) throw new Error("CREATOR_RENDER_TAMIL_FONT_MISSING");
  return { dir, family: CREATOR_CAPTION_FONT_FAMILY };
}

const DEFAULT_RENDER_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_RENDER_BYTES = 1024 * 1024 * 1024;

export async function executeFfmpegBounded(args: string[]): Promise<FfmpegExecution> {
  const executable = process.env.FFMPEG_PATH?.trim() || "ffmpeg";
  const timeoutMsRaw = Number(process.env.CREATOR_FFMPEG_TIMEOUT_MS || DEFAULT_RENDER_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0 ? Math.min(timeoutMsRaw, DEFAULT_RENDER_TIMEOUT_MS) : DEFAULT_RENDER_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
      if (stderr.length > 32_000) stderr = stderr.slice(-32_000);
    });
    child.on("error", (error) => finish(() => reject(new Error(`CREATOR_FFMPEG_SPAWN_FAILED:${error.message}`))));
    child.on("close", (code) => finish(() => resolve({ exitCode: code ?? -1, stderr })));

    const timer = setTimeout(() => {
      if (!settled) child.kill("SIGKILL");
      finish(() => reject(new Error("CREATOR_FFMPEG_TIMEOUT")));
    }, timeoutMs);
    timer.unref?.();
  });
}

export async function runCreatorRenderWorker(input: Omit<DeterministicRenderPlanInput, "subtitlePath" | "outputPath"> & {
  workspaceId: number;
  creatorProjectId: number;
  timelineId: number;
  exportId: number;
}, deps: RenderWorkerDependencies = {}) {
  if (![input.workspaceId, input.creatorProjectId, input.timelineId, input.exportId].every((value) => Number.isInteger(value) && value > 0)) {
    throw new Error("CREATOR_RENDER_ID_INVALID");
  }

  const createTempDir = deps.createTempDir ?? (() => mkdtemp(join(tmpdir(), "sakthiai-creator-")));
  const cleanupTempDir = deps.cleanupTempDir ?? ((path) => rm(path, { recursive: true, force: true }));
  const writeSubtitle = deps.writeSubtitle ?? ((path, content) => writeFile(path, content, { encoding: "utf8", flag: "wx" }));
  const readOutput = deps.readOutput ?? readFile;
  const execute = deps.executeFfmpeg ?? executeFfmpegBounded;
  const putArtifact = deps.putArtifact ?? storagePut;

  const tempDir = await createTempDir();
  const subtitlePath = join(tempDir, "captions.ta.srt");
  const outputPath = join(tempDir, "master-16x9.mp4");

  try {
    const captionFonts = input.captionFonts ?? deps.captionFonts
      ?? (captionsNeedTamilFont(input.captions) ? resolveCreatorCaptionFonts() : undefined);
    const plan = buildDeterministicRenderPlan({ ...input, subtitlePath, outputPath, captionFonts });
    await writeSubtitle(subtitlePath, plan.srt);

    const execution = await execute(plan.ffmpegArgs);
    if (execution.exitCode !== 0) {
      const detail = execution.stderr.trim().slice(-4000);
      throw new Error(`CREATOR_FFMPEG_FAILED:${execution.exitCode}${detail ? `:${detail}` : ""}`);
    }

    const output = await readOutput(outputPath);
    if (!output.length) throw new Error("CREATOR_RENDER_EMPTY_OUTPUT");
    if (output.byteLength > MAX_RENDER_BYTES) throw new Error("CREATOR_RENDER_OUTPUT_TOO_LARGE");

    const checksumSha256 = createHash("sha256").update(output).digest("hex");
    const storageKey = `creator/${input.workspaceId}/${input.creatorProjectId}/renders/timeline-${input.timelineId}/export-${input.exportId}.mp4`;
    const stored = await putArtifact(storageKey, output, "video/mp4");

    return {
      storageKey: stored.key,
      url: stored.url,
      checksumSha256,
      byteSize: output.byteLength,
      durationMs: plan.durationMs,
      frameCount: plan.frameCount,
      visualAssetIds: plan.visualAssetIds,
      renderer: "ffmpeg" as const,
      width: input.width,
      height: input.height,
      fps: input.fps,
    };
  } finally {
    await cleanupTempDir(tempDir).catch(() => undefined);
  }
}
