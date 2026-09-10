export type RenderVisualItem = {
  assetId: number;
  shotId?: number | null;
  assetType: "IMAGE" | "VIDEO";
  sourceUrl: string;
  startMs: number;
  endMs: number;
  track?: number;
  sortOrder?: number;
  approved: boolean;
};

export type RenderCaptionCue = {
  startMs: number;
  endMs: number;
  text: string;
  language: "ta" | "en";
  locked: boolean;
};

export type DeterministicRenderPlanInput = {
  width: number;
  height: number;
  fps: number;
  audioDurationMs: number;
  audioSourceUrl: string;
  visualItems: RenderVisualItem[];
  captions: RenderCaptionCue[];
  subtitlePath: string;
  outputPath: string;
};

export type DeterministicRenderPlan = {
  ffmpegArgs: string[];
  srt: string;
  durationMs: number;
  visualAssetIds: number[];
  frameCount: number;
};

function assertPositiveInt(value: number, code: string) {
  if (!Number.isInteger(value) || value <= 0) throw new Error(code);
}

function formatSrtTime(ms: number): string {
  if (!Number.isInteger(ms) || ms < 0) throw new Error("CREATOR_RENDER_TIME_INVALID");
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  const millis = ms % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
}

export function serializeSrt(cues: RenderCaptionCue[], durationMs: number): string {
  assertPositiveInt(durationMs, "CREATOR_RENDER_DURATION_INVALID");
  let previousEnd = 0;
  return cues.map((cue, index) => {
    if (!cue.locked) throw new Error("CREATOR_RENDER_CAPTION_NOT_LOCKED");
    if (cue.language !== "ta" && cue.language !== "en") throw new Error("CREATOR_RENDER_CAPTION_LANGUAGE_INVALID");
    if (!Number.isInteger(cue.startMs) || !Number.isInteger(cue.endMs) || cue.startMs < 0 || cue.endMs <= cue.startMs) {
      throw new Error("CREATOR_RENDER_CAPTION_RANGE_INVALID");
    }
    if (cue.startMs < previousEnd) throw new Error("CREATOR_RENDER_CAPTION_OVERLAP");
    if (cue.endMs > durationMs) throw new Error("CREATOR_RENDER_CAPTION_OUTSIDE_MASTER");
    const text = cue.text.trim();
    if (!text) throw new Error("CREATOR_RENDER_CAPTION_TEXT_REQUIRED");
    previousEnd = cue.endMs;
    return `${index + 1}\n${formatSrtTime(cue.startMs)} --> ${formatSrtTime(cue.endMs)}\n${text}\n`;
  }).join("\n");
}

function validateVisualItems(items: RenderVisualItem[], durationMs: number): RenderVisualItem[] {
  if (!items.length) throw new Error("CREATOR_RENDER_VISUALS_REQUIRED");
  const ordered = [...items].sort((a, b) => a.startMs - b.startMs || (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.assetId - b.assetId);
  let cursor = 0;
  const seen = new Set<number>();

  for (const item of ordered) {
    if (!item.approved) throw new Error("CREATOR_RENDER_VISUAL_NOT_APPROVED");
    if (item.track !== undefined && item.track !== 1) throw new Error("CREATOR_RENDER_VISUAL_TRACK_INVALID");
    if (seen.has(item.assetId)) throw new Error("CREATOR_RENDER_DUPLICATE_ASSET");
    if (!item.sourceUrl) throw new Error("CREATOR_RENDER_SOURCE_URL_REQUIRED");
    if (!Number.isInteger(item.startMs) || !Number.isInteger(item.endMs) || item.startMs < 0 || item.endMs <= item.startMs) {
      throw new Error("CREATOR_RENDER_VISUAL_RANGE_INVALID");
    }
    if (item.startMs !== cursor) throw new Error(item.startMs < cursor ? "CREATOR_RENDER_VISUAL_OVERLAP" : "CREATOR_RENDER_VISUAL_GAP");
    if (item.endMs > durationMs) throw new Error("CREATOR_RENDER_VISUAL_OUTSIDE_MASTER");
    cursor = item.endMs;
    seen.add(item.assetId);
  }

  if (cursor !== durationMs) throw new Error("CREATOR_RENDER_VISUALS_DO_NOT_COVER_MASTER");
  return ordered;
}

function escapeSubtitlePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

export function buildDeterministicRenderPlan(input: DeterministicRenderPlanInput): DeterministicRenderPlan {
  assertPositiveInt(input.width, "CREATOR_RENDER_WIDTH_INVALID");
  assertPositiveInt(input.height, "CREATOR_RENDER_HEIGHT_INVALID");
  assertPositiveInt(input.fps, "CREATOR_RENDER_FPS_INVALID");
  assertPositiveInt(input.audioDurationMs, "CREATOR_RENDER_DURATION_INVALID");
  if (!input.audioSourceUrl) throw new Error("CREATOR_RENDER_AUDIO_SOURCE_REQUIRED");
  if (!input.subtitlePath) throw new Error("CREATOR_RENDER_SUBTITLE_PATH_REQUIRED");
  if (!input.outputPath) throw new Error("CREATOR_RENDER_OUTPUT_PATH_REQUIRED");

  const visuals = validateVisualItems(input.visualItems, input.audioDurationMs);
  const srt = serializeSrt(input.captions, input.audioDurationMs);
  const args: string[] = ["-hide_banner", "-nostdin", "-y"];
  const filters: string[] = [];

  visuals.forEach((item, index) => {
    const durationSeconds = ((item.endMs - item.startMs) / 1000).toFixed(3);
    if (item.assetType === "IMAGE") args.push("-loop", "1", "-t", durationSeconds, "-i", item.sourceUrl);
    else args.push("-t", durationSeconds, "-i", item.sourceUrl);
    filters.push(
      `[${index}:v]scale=${input.width}:${input.height}:force_original_aspect_ratio=decrease,` +
      `pad=${input.width}:${input.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${input.fps},` +
      `trim=duration=${durationSeconds},setpts=PTS-STARTPTS[v${index}]`,
    );
  });

  const audioIndex = visuals.length;
  args.push("-i", input.audioSourceUrl);
  const concatInputs = visuals.map((_, index) => `[v${index}]`).join("");
  filters.push(`${concatInputs}concat=n=${visuals.length}:v=1:a=0[vc]`);
  filters.push(`[vc]subtitles='${escapeSubtitlePath(input.subtitlePath)}':charenc=UTF-8[vout]`);

  args.push(
    "-filter_complex", filters.join(";"),
    "-map", "[vout]",
    "-map", `${audioIndex}:a:0`,
    "-c:v", "libx264",
    "-preset", "medium",
    "-crf", "18",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "320k",
    "-ar", "48000",
    "-movflags", "+faststart",
    "-t", (input.audioDurationMs / 1000).toFixed(3),
    input.outputPath,
  );

  return {
    ffmpegArgs: args,
    srt,
    durationMs: input.audioDurationMs,
    visualAssetIds: visuals.map((item) => item.assetId),
    frameCount: Math.round((input.audioDurationMs / 1000) * input.fps),
  };
}
