import { and, eq, inArray } from "drizzle-orm";
import {
  creatorAssets,
  creatorCaptionCues,
  creatorShots,
  creatorTimelineItems,
  creatorTimelines,
} from "../../drizzle/schema";
import { getDb } from "../db";
import {
  creatorRenderIntentFingerprint,
  type CreatorRenderIntentInput,
} from "./renderIntent";

/**
 * Stage 4: server-owned read of the proposed render request.
 *
 * No caller-controlled media checksums, Tamil text, reference identity, signed
 * URLs or approval flags are accepted. This is a read-only, review-only helper.
 *
 * Important limitation: the timeline row is locked HERE, but current timeline
 * writers are not yet required to lock that same row. The resulting intent
 * therefore MUST NOT be passed to claimAndQueueExport in production until
 * timeline/caption writers, snapshot reservation and worker dispatch share a
 * reviewed transaction/locking protocol.
 */
type DbProvider = typeof getDb;
type StoredMedia = { checksumSha256: string; id: number; immutable: number; reviewDecision: string; assetType: string };
export type CreatorDbRenderIntentInput = {
  workspaceId: number;
  creatorProjectId: number;
  timelineId: number;
  /** Final 16:9 render asset ID for an optional 9:16 delivery derivative. */
  verticalDerivativeOf?: number;
};
export type TrustedCreatorRendererConfig = {
  rendererVersion: string;
  fontFamily: string;
};
function positive(n: number): boolean { return Number.isSafeInteger(n) && n > 0; }
function durationMs(provenanceJson: string): number {
  let metadata: { durationMs?: unknown };
  try { metadata = JSON.parse(provenanceJson); }
  catch { throw new Error("CREATOR_RENDER_INTENT_AUDIO_DURATION_INVALID"); }
  const n = metadata?.durationMs;
  if (typeof n !== "number" || !positive(n)) throw new Error("CREATOR_RENDER_INTENT_AUDIO_DURATION_INVALID");
  return n;
}
function sha256(s: string): boolean { return typeof s === "string" && /^[a-f0-9]{64}$/i.test(s); }
function immutableApproved(asset: StoredMedia | undefined, kind: string): void {
  if (!asset || asset.immutable !== 1 || asset.reviewDecision !== "APPROVED" || !sha256(asset.checksumSha256)) {
    throw new Error("CREATOR_RENDER_INTENT_SOURCE_NOT_IMMUTABLE_APPROVED:" + kind);
  }
}
function approvedMasterProvenance(asset: {
  provenanceJson: string; id: number; assetType: string; immutable: number;
  reviewDecision: string; checksumSha256: string;
}, timelineId: number, visualIds: number[], audioSha: string) {
  immutableApproved(asset, "approvedMaster");
  if (asset.assetType !== "RENDER") throw new Error("CREATOR_RENDER_INTENT_DERIVATIVE_MASTER_INVALID");
  let body: { source?: unknown; timelineId?: unknown; visualAssetIds?: unknown; audioMasterChecksumSha256?: unknown };
  try { body = JSON.parse(asset.provenanceJson); }
  catch { throw new Error("CREATOR_RENDER_INTENT_DERIVATIVE_PROVENANCE_INVALID"); }
  if (body.source !== "deterministic-creator-render" || body.timelineId !== timelineId ||
      !Array.isArray(body.visualAssetIds) ||
      body.visualAssetIds.length !== visualIds.length ||
      body.visualAssetIds.some((id, i) => id !== visualIds[i]) ||
      body.audioMasterChecksumSha256 !== audioSha) {
    throw new Error("CREATOR_RENDER_INTENT_DERIVATIVE_SOURCE_DRIFT");
  }
}
function validateScope(input: CreatorDbRenderIntentInput): void {
  if (![input.workspaceId, input.creatorProjectId, input.timelineId].every(positive) ||
      (input.verticalDerivativeOf !== undefined && !positive(input.verticalDerivativeOf))) {
    throw new Error("CREATOR_RENDER_INTENT_DB_SCOPE_INVALID");
  }
}

export async function readCreatorRenderIntentFromDatabase(
  input: CreatorDbRenderIntentInput,
  trustedConfig: TrustedCreatorRendererConfig,
  dbProvider: DbProvider = getDb,
): Promise<{ intent: CreatorRenderIntentInput; fingerprint: string }> {
  validateScope(input);
  if (!trustedConfig || typeof trustedConfig.rendererVersion !== "string" ||
      !trustedConfig.rendererVersion.trim() || typeof trustedConfig.fontFamily !== "string" ||
      !trustedConfig.fontFamily.trim()) {
    throw new Error("CREATOR_RENDER_INTENT_TRUSTED_CONFIG_REQUIRED");
  }
  const db = await dbProvider();
  if (!db) throw new Error("CREATOR_RENDER_INTENT_DATABASE_UNAVAILABLE");

  return db.transaction(async tx => {
    const [timeline] = await tx.select().from(creatorTimelines).where(and(
      eq(creatorTimelines.id, input.timelineId),
      eq(creatorTimelines.workspaceId, input.workspaceId),
      eq(creatorTimelines.creatorProjectId, input.creatorProjectId),
    )).limit(1).for("update");
    if (!timeline) throw new Error("CREATOR_RENDER_INTENT_TIMELINE_NOT_FOUND");
    if (timeline.width !== 1920 || timeline.height !== 1080 || !positive(timeline.fps) ||
        !timeline.audioMasterAssetId) throw new Error("CREATOR_RENDER_INTENT_MASTER_PROFILE_INVALID");

    const [audio] = await tx.select().from(creatorAssets).where(and(
      eq(creatorAssets.id, timeline.audioMasterAssetId),
      eq(creatorAssets.workspaceId, input.workspaceId),
      eq(creatorAssets.creatorProjectId, input.creatorProjectId),
    )).limit(1);
    immutableApproved(audio, "audio");
    if (audio.assetType !== "AUDIO_MASTER") throw new Error("CREATOR_RENDER_INTENT_AUDIO_TYPE_INVALID");

    const timelineItems = await tx.select().from(creatorTimelineItems).where(and(
      eq(creatorTimelineItems.workspaceId, input.workspaceId),
      eq(creatorTimelineItems.creatorProjectId, input.creatorProjectId),
      eq(creatorTimelineItems.timelineId, input.timelineId),
    )).orderBy(creatorTimelineItems.startMs, creatorTimelineItems.sortOrder, creatorTimelineItems.id);
    if (!timelineItems.length) throw new Error("CREATOR_RENDER_INTENT_EMPTY_TIMELINE");

    const shotIds = [...new Set(timelineItems.flatMap(item => item.shotId === null ? [] : [item.shotId]))];
    if (shotIds.some(id => !positive(id))) throw new Error("CREATOR_RENDER_INTENT_SHOT_ID_INVALID");
    const shots = shotIds.length ? await tx.select({ id: creatorShots.id }).from(creatorShots).where(and(
      eq(creatorShots.workspaceId, input.workspaceId),
      eq(creatorShots.creatorProjectId, input.creatorProjectId),
      inArray(creatorShots.id, shotIds),
    )) : [];
    const validShotIds = new Set(shots.map(row => row.id));
    if (validShotIds.size !== shotIds.length) throw new Error("CREATOR_RENDER_INTENT_FOREIGN_SHOT");

    const visuals: CreatorRenderIntentInput["visuals"][number][] = [];
    for (const item of timelineItems) {
      const [asset] = await tx.select().from(creatorAssets).where(and(
        eq(creatorAssets.id, item.assetId),
        eq(creatorAssets.workspaceId, input.workspaceId),
        eq(creatorAssets.creatorProjectId, input.creatorProjectId),
      )).limit(1);
      immutableApproved(asset, "visual");
      if (asset.assetType !== "IMAGE" && asset.assetType !== "VIDEO") {
        throw new Error("CREATOR_RENDER_INTENT_VISUAL_TYPE_INVALID");
      }
      if (item.shotId !== null && asset.shotId !== null && asset.shotId !== item.shotId) {
        throw new Error("CREATOR_RENDER_INTENT_SHOT_ASSET_MISMATCH");
      }
      visuals.push({
        assetId: item.assetId, checksumSha256: asset.checksumSha256,
        assetType: asset.assetType, shotId: item.shotId,
        startMs: item.startMs, endMs: item.endMs, track: item.track, sortOrder: item.sortOrder,
      });
    }

    const captionRows = await tx.select().from(creatorCaptionCues).where(and(
      eq(creatorCaptionCues.workspaceId, input.workspaceId),
      eq(creatorCaptionCues.creatorProjectId, input.creatorProjectId),
      eq(creatorCaptionCues.timelineId, input.timelineId),
    )).orderBy(creatorCaptionCues.startMs, creatorCaptionCues.id);
    const captions: CreatorRenderIntentInput["captions"][number][] = captionRows.map(row => ({
      startMs: row.startMs, endMs: row.endMs, language: row.language,
      text: row.text, locked: row.locked === 1,
    }));

    const mode = input.verticalDerivativeOf === undefined ? "MASTER_CANDIDATE" : "VERTICAL_DERIVATIVE";
    let derivativeOf: CreatorRenderIntentInput["derivativeOf"] = null;
    if (input.verticalDerivativeOf !== undefined) {
      const [parent] = await tx.select().from(creatorAssets).where(and(
        eq(creatorAssets.id, input.verticalDerivativeOf),
        eq(creatorAssets.workspaceId, input.workspaceId),
        eq(creatorAssets.creatorProjectId, input.creatorProjectId),
      )).limit(1);
      if (!parent) throw new Error("CREATOR_RENDER_INTENT_DERIVATIVE_MASTER_NOT_FOUND");
      approvedMasterProvenance(parent, input.timelineId, visuals.map(row => row.assetId), audio.checksumSha256);
      derivativeOf = { assetId: parent.id, checksumSha256: parent.checksumSha256 };
    }

    const intent: CreatorRenderIntentInput = {
      workspaceId: input.workspaceId,
      creatorProjectId: input.creatorProjectId,
      timelineId: input.timelineId,
      mode,
      audioMaster: { assetId: audio.id, checksumSha256: audio.checksumSha256, durationMs: durationMs(audio.provenanceJson) },
      visuals, captions,
      output: {
        width: mode === "MASTER_CANDIDATE" ? 1920 : 1080,
        height: mode === "MASTER_CANDIDATE" ? 1080 : 1920,
        fit: mode === "MASTER_CANDIDATE" ? "pad" : "cover",
        fps: timeline.fps,
        rendererVersion: trustedConfig.rendererVersion,
        fontFamily: trustedConfig.fontFamily,
      },
      derivativeOf,
    };
    const { fingerprint } = creatorRenderIntentFingerprint(intent);
    return { intent, fingerprint };
  });
}
