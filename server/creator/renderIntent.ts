import { createHash } from "node:crypto";

/**
 * A pure render-request fingerprint, NOT a render idempotency implementation.
 * Callers still need one consistent DB snapshot, a unique DB claim, fencing,
 * crash reconciliation, source-integrity checks, and human approval gates.
 */
export const CREATOR_RENDER_INTENT_VERSION = "creator-render-intent/v1" as const;

type Visual = {
  assetId: number;
  checksumSha256: string;
  assetType: "IMAGE" | "VIDEO";
  shotId?: number | null;
  startMs: number;
  endMs: number;
  track: number;
  sortOrder: number;
};
type Caption = { startMs: number; endMs: number; language: "ta" | "en"; text: string; locked: boolean };
type DigestAsset = { assetId: number; checksumSha256: string };

export type CreatorRenderIntentInput = {
  workspaceId: number;
  creatorProjectId: number;
  timelineId: number;
  mode: "MASTER_CANDIDATE" | "VERTICAL_DERIVATIVE";
  audioMaster: DigestAsset & { durationMs: number };
  visuals: readonly Visual[];
  captions: readonly Caption[];
  output: { width: number; height: number; fps: number; fit: "pad" | "cover"; rendererVersion: string; fontFamily: string };
  derivativeOf?: DigestAsset | null;
};

function invalid(field: string): never {
  throw new Error("CREATOR_RENDER_INTENT_INVALID:" + field);
}
function positiveSafeInt(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) return invalid(field);
  return value;
}
function nonnegativeSafeInt(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) return invalid(field);
  return value;
}
function checksumSha256(value: string, field: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/i.test(value)) return invalid(field);
  return value.toLowerCase();
}

/** Never returns caption text, credentials, media keys, or expiring signed URLs. */
export function creatorRenderIntentFingerprint(input: CreatorRenderIntentInput): {
  version: typeof CREATOR_RENDER_INTENT_VERSION; fingerprint: string
} {
  const workspaceId = positiveSafeInt(input.workspaceId, "workspaceId");
  const creatorProjectId = positiveSafeInt(input.creatorProjectId, "creatorProjectId");
  const timelineId = positiveSafeInt(input.timelineId, "timelineId");
  const mode = input.mode;
  if (mode !== "MASTER_CANDIDATE" && mode !== "VERTICAL_DERIVATIVE") invalid("mode");
  const output = input.output;
  const width = positiveSafeInt(output.width, "width");
  const height = positiveSafeInt(output.height, "height");
  const fps = positiveSafeInt(output.fps, "fps");
  if (typeof output.rendererVersion !== "string" || !output.rendererVersion.trim()) invalid("rendererVersion");
  if (typeof output.fontFamily !== "string" || !output.fontFamily.trim()) invalid("fontFamily");
  if ((mode === "MASTER_CANDIDATE" && (width !== 1920 || height !== 1080 || fps !== 24 || output.fit !== "pad")) ||
      (mode === "VERTICAL_DERIVATIVE" && (width !== 1080 || height !== 1920 || output.fit !== "cover"))) invalid("outputProfile");
  const derivativeOf = input.derivativeOf;
  if ((mode === "VERTICAL_DERIVATIVE") !== Boolean(derivativeOf)) invalid("derivativeOf");

  const audioMaster = {
    assetId: positiveSafeInt(input.audioMaster.assetId, "audioAssetId"),
    sha256: checksumSha256(input.audioMaster.checksumSha256, "audioSha256"),
    durationMs: positiveSafeInt(input.audioMaster.durationMs, "audioDurationMs"),
  };
  if (!input.visuals.length) invalid("visualsEmpty");
  const seenAssets = new Set<number>();
  const visuals = input.visuals.map(item => {
    const assetId = positiveSafeInt(item.assetId, "visualAssetId");
    if (seenAssets.has(assetId)) invalid("duplicateVisual");
    seenAssets.add(assetId);
    const startMs = nonnegativeSafeInt(item.startMs, "visualStartMs");
    const endMs = positiveSafeInt(item.endMs, "visualEndMs");
    if (endMs <= startMs) invalid("visualRange");
    if (item.track !== 1) invalid("track");
    if (item.assetType !== "IMAGE" && item.assetType !== "VIDEO") invalid("assetType");
    if (item.shotId != null) positiveSafeInt(item.shotId, "shotId");
    return {
      assetId, sha256: checksumSha256(item.checksumSha256, "visualSha256"),
      assetType: item.assetType, shotId: item.shotId ?? null,
      startMs, endMs, track: item.track,
      sortOrder: nonnegativeSafeInt(item.sortOrder, "sortOrder"),
    };
  }).sort((a, b) => a.startMs - b.startMs || a.sortOrder - b.sortOrder || a.assetId - b.assetId);
  let cursor = 0;
  for (const visual of visuals) {
    if (visual.startMs !== cursor) {
      throw new Error(visual.startMs < cursor ? "CREATOR_RENDER_INTENT_OVERLAP" : "CREATOR_RENDER_INTENT_GAP");
    }
    cursor = visual.endMs;
  }
  if (cursor !== audioMaster.durationMs) throw new Error("CREATOR_RENDER_INTENT_INCOMPLETE_COVERAGE");

  if (!input.captions.length) invalid("captionsEmpty");
  let prevCueEnd = 0;
  const captions = input.captions.map(cue => {
    const startMs = nonnegativeSafeInt(cue.startMs, "captionStartMs");
    const endMs = positiveSafeInt(cue.endMs, "captionEndMs");
    if (endMs <= startMs || endMs > audioMaster.durationMs || startMs < prevCueEnd) invalid("captionRange");
    prevCueEnd = endMs;
    if (!cue.locked || (cue.language !== "ta" && cue.language !== "en") ||
        typeof cue.text !== "string" || !cue.text.trim()) invalid("caption");
    // Preserve Tamil combining characters exactly as the existing SRT renderer does.
    return { startMs, endMs, language: cue.language, text: cue.text.trim(), locked: true };
  });
  const canonical = {
    version: CREATOR_RENDER_INTENT_VERSION, workspaceId, creatorProjectId, timelineId, mode,
    audioMaster, visuals, captions,
    output: {
      width, height, fps, fit: output.fit,
      rendererVersion: output.rendererVersion, fontFamily: output.fontFamily,
    },
    derivativeOf: derivativeOf ? {
      assetId: positiveSafeInt(derivativeOf.assetId, "derivativeAssetId"),
      sha256: checksumSha256(derivativeOf.checksumSha256, "derivativeSha256"),
    } : null,
  };
  return {
    version: CREATOR_RENDER_INTENT_VERSION,
    fingerprint: createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex"),
  };
}
