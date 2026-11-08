import { and, eq } from "drizzle-orm";
import { creatorAssets, creatorTimelineItems, creatorTimelines } from "../../drizzle/schema";
import { getDb } from "../db";

export type TimelineItemInput = {
  assetId: number;
  shotId?: number;
  startMs: number;
  endMs: number;
  track?: number;
  sortOrder?: number;
};

function readDurationMs(provenanceJson: string): number {
  try {
    const value = JSON.parse(provenanceJson) as { durationMs?: unknown };
    if (Number.isInteger(value.durationMs) && Number(value.durationMs) > 0) return Number(value.durationMs);
  } catch {
    // Bound malformed metadata below.
  }
  throw new Error("CREATOR_TIMELINE_AUDIO_DURATION_INVALID");
}

export function validateTimelineCoverage(items: TimelineItemInput[], durationMs: number) {
  if (!Number.isInteger(durationMs) || durationMs <= 0) throw new Error("CREATOR_TIMELINE_DURATION_INVALID");
  if (!items.length) throw new Error("CREATOR_TIMELINE_ITEMS_REQUIRED");
  const normalized = [...items]
    .map((item, index) => ({ ...item, track: item.track ?? 1, sortOrder: item.sortOrder ?? index }))
    .sort((a, b) => a.startMs - b.startMs || a.sortOrder - b.sortOrder || a.assetId - b.assetId);

  let cursor = 0;
  const seen = new Set<number>();
  for (const item of normalized) {
    if (!Number.isInteger(item.assetId) || item.assetId <= 0) throw new Error("CREATOR_TIMELINE_ASSET_ID_INVALID");
    if (seen.has(item.assetId)) throw new Error("CREATOR_TIMELINE_DUPLICATE_ASSET");
    if (item.track !== 1) throw new Error("CREATOR_TIMELINE_VISUAL_TRACK_INVALID");
    if (!Number.isInteger(item.startMs) || !Number.isInteger(item.endMs) || item.startMs < 0 || item.endMs <= item.startMs) {
      throw new Error("CREATOR_TIMELINE_RANGE_INVALID");
    }
    if (item.startMs !== cursor) throw new Error(item.startMs < cursor ? "CREATOR_TIMELINE_OVERLAP" : "CREATOR_TIMELINE_GAP");
    if (item.endMs > durationMs) throw new Error("CREATOR_TIMELINE_OUTSIDE_AUDIO_MASTER");
    cursor = item.endMs;
    seen.add(item.assetId);
  }
  if (cursor !== durationMs) throw new Error("CREATOR_TIMELINE_INCOMPLETE_COVERAGE");
  return normalized;
}

export async function replaceApprovedTimelineItems(input: {
  workspaceId: number;
  creatorProjectId: number;
  timelineId: number;
  items: TimelineItemInput[];
}) {
  const db = await getDb();
  if (!db) throw new Error("CREATOR_DATABASE_UNAVAILABLE");
  const [timeline] = await db.select().from(creatorTimelines).where(and(
    eq(creatorTimelines.id, input.timelineId),
    eq(creatorTimelines.workspaceId, input.workspaceId),
    eq(creatorTimelines.creatorProjectId, input.creatorProjectId),
  )).limit(1);
  if (!timeline) throw new Error("CREATOR_TIMELINE_NOT_FOUND");
  if (!timeline.audioMasterAssetId) throw new Error("CREATOR_TIMELINE_AUDIO_MASTER_MISSING");

  const [audioMaster] = await db.select().from(creatorAssets).where(and(
    eq(creatorAssets.id, timeline.audioMasterAssetId),
    eq(creatorAssets.workspaceId, input.workspaceId),
    eq(creatorAssets.creatorProjectId, input.creatorProjectId),
  )).limit(1);
  if (!audioMaster || audioMaster.assetType !== "AUDIO_MASTER" || audioMaster.immutable !== 1 || audioMaster.reviewDecision !== "APPROVED") {
    throw new Error("CREATOR_TIMELINE_AUDIO_MASTER_INVALID");
  }

  const normalized = validateTimelineCoverage(input.items, readDurationMs(audioMaster.provenanceJson));
  for (const item of normalized) {
    const [asset] = await db.select().from(creatorAssets).where(and(
      eq(creatorAssets.id, item.assetId),
      eq(creatorAssets.workspaceId, input.workspaceId),
      eq(creatorAssets.creatorProjectId, input.creatorProjectId),
    )).limit(1);
    if (!asset) throw new Error("CREATOR_TIMELINE_ASSET_NOT_FOUND");
    if (asset.assetType !== "IMAGE" && asset.assetType !== "VIDEO") throw new Error("CREATOR_TIMELINE_ASSET_TYPE_INVALID");
    if (asset.reviewDecision !== "APPROVED") throw new Error("CREATOR_TIMELINE_ASSET_NOT_APPROVED");
    if (item.shotId && asset.shotId && item.shotId !== asset.shotId) throw new Error("CREATOR_TIMELINE_SHOT_ASSET_MISMATCH");
  }

  await db.transaction(async (tx) => {
    await tx.delete(creatorTimelineItems).where(and(
      eq(creatorTimelineItems.workspaceId, input.workspaceId),
      eq(creatorTimelineItems.creatorProjectId, input.creatorProjectId),
      eq(creatorTimelineItems.timelineId, input.timelineId),
    ));
    await tx.insert(creatorTimelineItems).values(normalized.map((item) => ({
      workspaceId: input.workspaceId,
      creatorProjectId: input.creatorProjectId,
      timelineId: input.timelineId,
      assetId: item.assetId,
      shotId: item.shotId ?? null,
      track: item.track,
      sortOrder: item.sortOrder,
      startMs: item.startMs,
      endMs: item.endMs,
    })));
  });

  return { timelineId: input.timelineId, itemCount: normalized.length, durationMs: readDurationMs(audioMaster.provenanceJson), completeCoverage: true as const };
}
