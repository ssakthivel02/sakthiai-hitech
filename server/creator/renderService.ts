import { and, eq } from "drizzle-orm";
import {
  creatorAssets,
  creatorCaptionCues,
  creatorExports,
  creatorTimelineItems,
  creatorTimelines,
} from "../../drizzle/schema";
import { getDb } from "../db";
import { storageGetSignedUrl } from "../storage";
import { runCreatorRenderWorker, type RenderWorkerDependencies } from "./renderWorker";

async function requireDb() {
  const db = await getDb();
  if (!db) throw new Error("CREATOR_DATABASE_UNAVAILABLE");
  return db;
}

function durationFromProvenance(provenanceJson: string): number {
  try {
    const parsed = JSON.parse(provenanceJson) as { durationMs?: unknown };
    if (Number.isInteger(parsed.durationMs) && Number(parsed.durationMs) > 0) return Number(parsed.durationMs);
  } catch {
    // Convert malformed provenance into a bounded Creator error below.
  }
  throw new Error("CREATOR_RENDER_AUDIO_DURATION_INVALID");
}

export async function executeCreatorTimelineExport(input: {
  workspaceId: number;
  creatorProjectId: number;
  timelineId: number;
}, deps: RenderWorkerDependencies & { getSignedUrl?: (key: string) => Promise<string> } = {}) {
  const db = await requireDb();
  const [timeline] = await db
    .select()
    .from(creatorTimelines)
    .where(and(
      eq(creatorTimelines.id, input.timelineId),
      eq(creatorTimelines.workspaceId, input.workspaceId),
      eq(creatorTimelines.creatorProjectId, input.creatorProjectId),
    ))
    .limit(1);
  if (!timeline) throw new Error("CREATOR_RENDER_TIMELINE_NOT_FOUND");
  if (!timeline.audioMasterAssetId) throw new Error("CREATOR_RENDER_AUDIO_MASTER_MISSING");
  if (timeline.width !== 1920 || timeline.height !== 1080) throw new Error("CREATOR_RENDER_MASTER_MUST_BE_16X9_1080P");

  const [audioMaster] = await db
    .select()
    .from(creatorAssets)
    .where(and(
      eq(creatorAssets.id, timeline.audioMasterAssetId),
      eq(creatorAssets.workspaceId, input.workspaceId),
      eq(creatorAssets.creatorProjectId, input.creatorProjectId),
    ))
    .limit(1);
  if (!audioMaster || audioMaster.assetType !== "AUDIO_MASTER" || audioMaster.immutable !== 1 || audioMaster.reviewDecision !== "APPROVED") {
    throw new Error("CREATOR_RENDER_AUDIO_MASTER_NOT_APPROVED");
  }
  const durationMs = durationFromProvenance(audioMaster.provenanceJson);

  const timelineItems = await db
    .select()
    .from(creatorTimelineItems)
    .where(and(
      eq(creatorTimelineItems.workspaceId, input.workspaceId),
      eq(creatorTimelineItems.creatorProjectId, input.creatorProjectId),
      eq(creatorTimelineItems.timelineId, input.timelineId),
    ))
    .orderBy(creatorTimelineItems.startMs, creatorTimelineItems.sortOrder, creatorTimelineItems.id);

  const getSignedUrl = deps.getSignedUrl ?? storageGetSignedUrl;
  const visualItems = [];
  for (const item of timelineItems) {
    const [asset] = await db
      .select()
      .from(creatorAssets)
      .where(and(
        eq(creatorAssets.id, item.assetId),
        eq(creatorAssets.workspaceId, input.workspaceId),
        eq(creatorAssets.creatorProjectId, input.creatorProjectId),
      ))
      .limit(1);
    if (!asset) throw new Error("CREATOR_RENDER_TIMELINE_ASSET_NOT_FOUND");
    if (asset.assetType !== "IMAGE" && asset.assetType !== "VIDEO") throw new Error("CREATOR_RENDER_TIMELINE_ASSET_INVALID");
    visualItems.push({
      assetId: asset.id,
      shotId: item.shotId,
      assetType: asset.assetType,
      sourceUrl: await getSignedUrl(asset.storageKey),
      startMs: item.startMs,
      endMs: item.endMs,
      track: item.track,
      sortOrder: item.sortOrder,
      approved: asset.reviewDecision === "APPROVED",
    });
  }

  const captions = await db
    .select()
    .from(creatorCaptionCues)
    .where(and(
      eq(creatorCaptionCues.workspaceId, input.workspaceId),
      eq(creatorCaptionCues.creatorProjectId, input.creatorProjectId),
      eq(creatorCaptionCues.timelineId, input.timelineId),
    ))
    .orderBy(creatorCaptionCues.startMs, creatorCaptionCues.id);
  if (!captions.length) throw new Error("CREATOR_RENDER_LOCKED_CAPTIONS_REQUIRED");

  const exportInsert = await db.insert(creatorExports).values({
    workspaceId: input.workspaceId,
    creatorProjectId: input.creatorProjectId,
    timelineId: input.timelineId,
    status: "QUEUED",
    width: timeline.width,
    height: timeline.height,
    format: "mp4",
    renderer: "ffmpeg",
    parametersJson: JSON.stringify({
      deterministic: true,
      audioMasterAssetId: audioMaster.id,
      audioMasterChecksumSha256: audioMaster.checksumSha256,
      durationMs,
      fps: timeline.fps,
      visualAssetIds: visualItems.map(item => item.assetId),
      captionCueCount: captions.length,
    }),
  });
  const exportId = Number(exportInsert[0].insertId);
  if (!exportId) throw new Error("CREATOR_RENDER_EXPORT_CREATE_FAILED");

  await db.update(creatorExports).set({ status: "RUNNING" }).where(and(
    eq(creatorExports.id, exportId),
    eq(creatorExports.workspaceId, input.workspaceId),
  ));

  try {
    const rendered = await runCreatorRenderWorker({
      workspaceId: input.workspaceId,
      creatorProjectId: input.creatorProjectId,
      timelineId: input.timelineId,
      exportId,
      width: timeline.width,
      height: timeline.height,
      fps: timeline.fps,
      audioDurationMs: durationMs,
      audioSourceUrl: await getSignedUrl(audioMaster.storageKey),
      visualItems,
      captions: captions.map(cue => ({
        startMs: cue.startMs,
        endMs: cue.endMs,
        text: cue.text,
        language: cue.language,
        locked: cue.locked === 1,
      })),
    }, deps);

    const provenance = {
      source: "deterministic-creator-render",
      renderer: rendered.renderer,
      exportId,
      timelineId: input.timelineId,
      audioMasterAssetId: audioMaster.id,
      audioMasterChecksumSha256: audioMaster.checksumSha256,
      visualAssetIds: rendered.visualAssetIds,
      durationMs: rendered.durationMs,
      frameCount: rendered.frameCount,
      width: rendered.width,
      height: rendered.height,
      fps: rendered.fps,
      checksumSha256: rendered.checksumSha256,
      renderedAt: new Date().toISOString(),
    };
    const assetInsert = await db.insert(creatorAssets).values({
      workspaceId: input.workspaceId,
      creatorProjectId: input.creatorProjectId,
      assetType: "RENDER",
      mimeType: "video/mp4",
      storageKey: rendered.storageKey,
      checksumSha256: rendered.checksumSha256,
      byteSize: rendered.byteSize,
      immutable: 1,
      provenanceJson: JSON.stringify(provenance),
      reviewDecision: "PENDING",
    });
    const assetId = Number(assetInsert[0].insertId);
    if (!assetId) throw new Error("CREATOR_RENDER_ASSET_CREATE_FAILED");

    await db.update(creatorExports).set({
      status: "SUCCEEDED",
      assetId,
      checksumSha256: rendered.checksumSha256,
      completedAt: new Date(),
    }).where(and(eq(creatorExports.id, exportId), eq(creatorExports.workspaceId, input.workspaceId)));

    return { exportId, assetId, ...rendered, reviewDecision: "PENDING" as const };
  } catch (error) {
    await db.update(creatorExports).set({ status: "FAILED", completedAt: new Date() }).where(and(
      eq(creatorExports.id, exportId),
      eq(creatorExports.workspaceId, input.workspaceId),
    )).catch(() => undefined);
    throw error;
  }
}
