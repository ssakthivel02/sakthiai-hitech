import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CreatorOutputEvidence } from "./qualityGate";

const execFileAsync = promisify(execFile);
export type CreatorProbeRunner = (path: string) => Promise<string>;
const PROBE_TIMEOUT_MS = 15_000;
const PROBE_MAX_BYTES = 128 * 1024;

/** Probe only the local FFmpeg-produced file, never a caller URL or remote object. */
export async function runCreatorFfprobe(path: string): Promise<string> {
  if (!path || path.includes("\0")) throw new Error("CREATOR_RENDER_FFPROBE_PATH_INVALID");
  try {
    const { stdout } = await execFileAsync(process.env.FFPROBE_PATH?.trim() || "ffprobe", [
      "-v", "error", "-show_entries",
      "format=format_name,duration:stream=codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate",
      "-of", "json", path,
    ], { timeout: PROBE_TIMEOUT_MS, maxBuffer: PROBE_MAX_BYTES, windowsHide: true });
    return stdout;
  } catch {
    throw new Error("CREATOR_RENDER_FFPROBE_FAILED");
  }
}

function rationalFps(value: unknown): number {
  if (typeof value !== "string") return NaN;
  const match = /^(\d+)(?:\/(\d+))?$/.exec(value);
  if (!match) return NaN;
  const denominator = match[2] ? Number(match[2]) : 1;
  return denominator > 0 ? Number(match[1]) / denominator : NaN;
}

/** Technical output evidence only: never invents a human visual/Tamil quality score. */
export async function probeCreatorRenderedOutput(
  path: string,
  target: CreatorOutputEvidence,
  run: CreatorProbeRunner = runCreatorFfprobe,
): Promise<CreatorOutputEvidence> {
  if (![target.width, target.height, target.fps].every(n => Number.isSafeInteger(n) && n > 0) ||
      !Number.isFinite(target.durationSeconds) || target.durationSeconds <= 0 ||
      target.hasAudio !== true) {
    throw new Error("CREATOR_RENDER_PROBE_TARGET_INVALID");
  }
  let parsed: { streams?: unknown; format?: { duration?: unknown; format_name?: unknown } };
  try { parsed = JSON.parse(await run(path)) as typeof parsed; }
  catch { throw new Error("CREATOR_RENDER_FFPROBE_INVALID_JSON"); }
  if (!parsed || !Array.isArray(parsed.streams)) throw new Error("CREATOR_RENDER_FFPROBE_STREAMS_INVALID");
  const streams = parsed.streams as Array<{
    codec_type?: unknown; codec_name?: unknown; width?: unknown; height?: unknown;
    avg_frame_rate?: unknown; r_frame_rate?: unknown;
  }>;
  const containerTokens = typeof parsed.format?.format_name === "string"
    ? parsed.format.format_name.toLowerCase().split(",").map(token => token.trim())
    : [];
  if (!containerTokens.includes("mp4")) throw new Error("CREATOR_RENDER_OUTPUT_CONTAINER_INVALID");
  const videos = streams.filter(s => s && s.codec_type === "video");
  if (videos.length !== 1) throw new Error("CREATOR_RENDER_FFPROBE_VIDEO_STREAM_INVALID");
  const video = videos[0];
  if (typeof video.codec_name !== "string" || video.codec_name.trim().toLowerCase() !== "h264") {
    throw new Error("CREATOR_RENDER_OUTPUT_VIDEO_CODEC_INVALID");
  }
  const audios = streams.filter(s => s && s.codec_type === "audio");
  const hasAudio = audios.length > 0;
  if (hasAudio && !audios.some(audio => typeof audio.codec_name === "string" && audio.codec_name.trim().toLowerCase() === "aac")) {
    throw new Error("CREATOR_RENDER_OUTPUT_AUDIO_CODEC_INVALID");
  }
  const fpsAverage = rationalFps(video.avg_frame_rate);
  const fpsNominal = rationalFps(video.r_frame_rate);
  const durationSeconds = Number(parsed.format?.duration);
  if (!Number.isSafeInteger(video.width) || !Number.isSafeInteger(video.height) ||
      !Number.isFinite(fpsAverage) || fpsAverage <= 0 ||
      !Number.isFinite(fpsNominal) || fpsNominal <= 0 ||
      !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error("CREATOR_RENDER_FFPROBE_METADATA_INVALID");
  }
  const actual: CreatorOutputEvidence = {
    width: video.width as number,
    height: video.height as number,
    fps: fpsAverage,
    durationSeconds,
    hasAudio,
  };
  const failures: string[] = [];
  if (actual.width !== target.width) failures.push("width");
  if (actual.height !== target.height) failures.push("height");
  if (Math.abs(actual.fps - target.fps) > 0.01 || Math.abs(fpsNominal - target.fps) > 0.01) failures.push("fps");
  if (Math.abs(actual.durationSeconds - target.durationSeconds) > 0.1) failures.push("duration");
  if (!actual.hasAudio) failures.push("audio");
  if (failures.length) throw new Error(`CREATOR_RENDER_OUTPUT_NONCONFORMANT:${failures.join(",")}`);
  return actual;
}
