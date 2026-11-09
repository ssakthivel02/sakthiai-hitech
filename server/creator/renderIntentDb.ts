import { and, eq, inArray } from "drizzle-orm";
import {
  creatorAssets,
  creatorCaptionCues,
  creatorShots,
  creatorTimelineItems,
  creatorTimelines,
} from "../../drizzle/schema";
import { getDb } from "../db";
import { ExistingRenderClaim, MysqlCreatorRenderClaims, type CreatorRenderQueuedResult, type CreatorRenderSqlTransaction } from "./renderClaims";
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
 * The read-only API remains available. The source-derived reservation API
 * performs the read and durable claim/export insertion under ONE row lock.
 * Neither API starts a worker; fenced dispatch and crash recovery are separate gates.
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
function immutableApproved(asset: StoredMedia | undefined, kind: string): asserts asset is StoredMedia {
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

/**
 * Source snapshot and caller's operation execute in ONE MySQL transaction.
 * The timeline row lock is held through the caller's callback, including
 * any claim/export insertion. No signed URL or worker dispatch is permitted.
 */
export async function withCreatorRenderIntentTransaction<T>(
  input: CreatorDbRenderIntentInput,
  trustedConfig: TrustedCreatorRendererConfig,
  onLockedSnapshot: (tx: CreatorRenderSqlTransaction, snapshot: { intent: CreatorRenderIntentInput; fingerprint: string }) => Promise<T>,
  dbProvider: DbProvider = getDb,
): Promise<T> {
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
    return onLockedSnapshot(tx, { intent, fingerprint });
  });
}

/** Retain the existing read-only API; callers cannot reserve outside its lock. */
export async function readCreatorRenderIntentFromDatabase(
  input: CreatorDbRenderIntentInput,
  trustedConfig: TrustedCreatorRendererConfig,
  dbProvider: DbProvider = getDb,
): Promise<{ intent: CreatorRenderIntentInput; fingerprint: string }> {
  return withCreatorRenderIntentTransaction(input, trustedConfig, async (_tx, snapshot) => snapshot, dbProvider);
}

/**
 * Atomic source-derived render reservation. This is NOT worker activation.
 * A duplicate returns the existing claim only after the lock/insert
 * transaction resolves; no lease token is exposed to duplicate callers.
 */
export async function reserveCreatorRenderIntentFromDatabase(
  input: CreatorDbRenderIntentInput,
  trustedConfig: TrustedCreatorRendererConfig,
  dbProvider: DbProvider = getDb,
  leaseSeconds = 1800,
): Promise<CreatorRenderQueuedResult> {
  const claims = new MysqlCreatorRenderClaims(dbProvider);
  let duplicateScope: { workspaceId: number; creatorProjectId: number; timelineId: number; mode: CreatorRenderIntentInput["mode"]; fingerprint: string } | undefined;
  try {
    return await withCreatorRenderIntentTransaction(input, trustedConfig, async (tx, snapshot) => {
      duplicateScope = {
        workspaceId: snapshot.intent.workspaceId,
        creatorProjectId: snapshot.intent.creatorProjectId,
        timelineId: snapshot.intent.timelineId,
        mode: snapshot.intent.mode,
        fingerprint: snapshot.fingerprint,
      };
      return claims.reserveInsideTransaction(tx, snapshot.intent, leaseSeconds);
    }, dbProvider);
  } catch (error) {
    if (!(error instanceof ExistingRenderClaim) || !duplicateScope) throw error;
    return claims.resolveDuplicate(duplicateScope);
  }
}
