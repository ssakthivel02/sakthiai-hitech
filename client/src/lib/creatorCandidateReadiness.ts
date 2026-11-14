/**
 * Browser-only render preflight: never a substitute for the owner-only server
 * render fence, DB source locks or storage checksum verification.
 *
 * Fail closed if ANY persisted visual is revoked, a timeline is incomplete,
 * the audio-master identity changes or a caption loses its human lock.
 */
export type CreatorCandidateReadinessInput = {
  project?: { audioMasterAssetId: number | null } | null;
  timeline?: {
    id: number; audioMasterAssetId: number | null;
    width: number; height: number; fps: number;
  } | null;
  assets?: readonly {
    id: number; assetType: string; reviewDecision: string; immutable: number;
    checksumSha256: string; provenanceJson: string; shotId?: number | null;
  }[] | null;
  items?: readonly {
    timelineId: number; assetId: number; shotId?: number | null;
    startMs: number; endMs: number; track: number;
  }[] | null;
  cues?: readonly {
    timelineId: number; startMs: number; endMs: number;
    language: string; text: string; locked: number;
  }[] | null;
};

function approved(asset: NonNullable<CreatorCandidateReadinessInput["assets"]>[number] | undefined) {
  return Boolean(asset && asset.immutable === 1 && asset.reviewDecision === "APPROVED" &&
    /^[a-f0-9]{64}$/i.test(asset.checksumSha256));
}
function audioDuration(json: string | undefined): number | null {
  try {
    const parsed = JSON.parse(json ?? "{}") as { durationMs?: unknown };
    return typeof parsed.durationMs === "number" && Number.isSafeInteger(parsed.durationMs) &&
      parsed.durationMs > 0 ? parsed.durationMs : null;
  } catch { return null; }
}
export function creatorCandidateReadiness(input: CreatorCandidateReadinessInput) {
  const timeline = input.timeline;
  const profile = Boolean(timeline && timeline.width === 1920 && timeline.height === 1080 && timeline.fps === 24);
  const audioId = input.project?.audioMasterAssetId;
  const audioAsset = input.assets?.find(asset => asset.id === audioId);
  const duration = audioDuration(audioAsset?.provenanceJson);
  const audio = Boolean(timeline && audioId && timeline.audioMasterAssetId === audioId &&
    audioAsset?.assetType === "AUDIO_MASTER" && approved(audioAsset) && duration);

  const items = (input.items ?? []).filter(item => item.timelineId === timeline?.id)
    .sort((a, b) => a.startMs - b.startMs || a.assetId - b.assetId);
  let cursor = 0;
  const seen = new Set<number>();
  const visuals = Boolean(audio && profile && items.length && items.every(item => {
    const asset = input.assets?.find(candidate => candidate.id === item.assetId);
    if (!asset || seen.has(item.assetId) || !approved(asset) ||
        (asset.assetType !== "IMAGE" && asset.assetType !== "VIDEO") ||
        item.track !== 1 || !Number.isSafeInteger(item.startMs) ||
        !Number.isSafeInteger(item.endMs) || item.startMs !== cursor ||
        item.endMs <= item.startMs || item.endMs > duration! ||
        (item.shotId != null && asset.shotId != null && item.shotId !== asset.shotId)) return false;
    seen.add(item.assetId);
    cursor = item.endMs;
    return true;
  }) && cursor === duration);

  const cues = (input.cues ?? []).filter(cue => cue.timelineId === timeline?.id)
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  let previousEnd = 0;
  const tamil = Boolean(audio && profile && cues.length &&
    cues.some(cue => cue.language === "ta") && cues.every(cue => {
      if (cue.locked !== 1 || !cue.text.trim() ||
          !Number.isSafeInteger(cue.startMs) || !Number.isSafeInteger(cue.endMs) ||
          cue.startMs < previousEnd || cue.endMs <= cue.startMs || cue.endMs > duration! ||
          (cue.language !== "ta" && cue.language !== "en")) return false;
      previousEnd = cue.endMs;
      return true;
    }));
  return { audio, visuals, tamil, profile };
}
