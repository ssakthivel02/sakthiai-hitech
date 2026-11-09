import { and, eq } from "drizzle-orm";
import { creatorAssets } from "../../drizzle/schema";
import { getDb } from "../db";
import { storageGetSignedUrl, storageVerifySha256 } from "../storage";
import { MysqlCreatorRenderClaims, type CreatorRenderClaimScope } from "./renderClaims";
import {
  readCreatorRenderIntentFromDatabase,
  reserveCreatorRenderIntentFromDatabase,
  type CreatorDbRenderIntentInput,
  type TrustedCreatorRendererConfig,
} from "./renderIntentDb";
import type { CreatorRenderIntentInput } from "./renderIntent";
import type { RenderVisualItem } from "./renderPlan";
import { CREATOR_CAPTION_FONT_FAMILY, runCreatorRenderWorker, type RenderWorkerDependencies } from "./renderWorker";

/**
 * Explicitly invoked, single-claim worker entry point. Not attached to an API
 * route or cron: activation still requires a source-lock-at-finalize gate.
 * Never retries or launches a duplicate claim.
 */
type TrustedMedia = { audioSourceUrl: string; visualItems: RenderVisualItem[] };
type Worker = typeof runCreatorRenderWorker;
type Claims = Pick<MysqlCreatorRenderClaims, "heartbeat" | "finalizeVerifiedExport" | "markUnknown">;
export type CreatorRenderDispatchDependencies = {
  reserve?: typeof reserveCreatorRenderIntentFromDatabase;
  read?: typeof readCreatorRenderIntentFromDatabase;
  claims?: Claims;
  resolveMedia?: (intent: CreatorRenderIntentInput) => Promise<TrustedMedia>;
  render?: Worker;
  workerDependencies?: RenderWorkerDependencies;
  heartbeatIntervalMs?: number;
  leaseSeconds?: number;
};

function renderScope(intent: CreatorRenderIntentInput, fingerprint: string): CreatorRenderClaimScope {
  return {
    workspaceId: intent.workspaceId,
    creatorProjectId: intent.creatorProjectId,
    timelineId: intent.timelineId,
    mode: intent.mode,
    fingerprint,
  };
}

/** Every URL is resolved from a scoped DB row, never from a caller-supplied key. */
export async function resolveTrustedCreatorRenderMedia(intent: CreatorRenderIntentInput): Promise<TrustedMedia> {
  const db = await getDb();
  if (!db) throw new Error("CREATOR_RENDER_DISPATCH_DATABASE_UNAVAILABLE");
  const resolveAsset = async (assetId: number, sha256: string, expectedType: string) => {
    const [asset] = await db.select().from(creatorAssets).where(and(
      eq(creatorAssets.id, assetId),
      eq(creatorAssets.workspaceId, intent.workspaceId),
      eq(creatorAssets.creatorProjectId, intent.creatorProjectId),
    )).limit(1);
    if (!asset || asset.assetType !== expectedType || asset.immutable !== 1 ||
        asset.reviewDecision !== "APPROVED" ||
        asset.checksumSha256.toLowerCase() !== sha256.toLowerCase() ||
        typeof asset.byteSize !== "number" || !Number.isSafeInteger(asset.byteSize) || asset.byteSize <= 0) {
      throw new Error("CREATOR_RENDER_DISPATCH_SOURCE_DRIFT");
    }
    await storageVerifySha256(asset.storageKey, asset.byteSize, sha256.toLowerCase());
    return storageGetSignedUrl(asset.storageKey);
  };
  const audioSourceUrl = await resolveAsset(
    intent.audioMaster.assetId, intent.audioMaster.checksumSha256, "AUDIO_MASTER",
  );
  const visualItems: RenderVisualItem[] = [];
  for (const item of intent.visuals) {
    visualItems.push({
      assetId: item.assetId,
      shotId: item.shotId,
      assetType: item.assetType,
      sourceUrl: await resolveAsset(item.assetId, item.checksumSha256, item.assetType),
      startMs: item.startMs,
      endMs: item.endMs,
      track: item.track,
      sortOrder: item.sortOrder,
      approved: true,
    });
  }
  return { audioSourceUrl, visualItems };
}

export async function dispatchReservedCreatorRender(
  input: CreatorDbRenderIntentInput,
  trustedConfig: TrustedCreatorRendererConfig,
  deps: CreatorRenderDispatchDependencies = {},
) {
  if (trustedConfig.fontFamily !== CREATOR_CAPTION_FONT_FAMILY) {
    throw new Error("CREATOR_RENDER_DISPATCH_FONT_IDENTITY_INVALID");
  }
  const leaseSeconds = deps.leaseSeconds ?? 1800;
  const intervalMs = deps.heartbeatIntervalMs ?? 30_000;
  if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 1800 ||
      !Number.isSafeInteger(intervalMs) || intervalMs < 100 || intervalMs >= leaseSeconds * 1000) {
    throw new Error("CREATOR_RENDER_DISPATCH_HEARTBEAT_CONFIG_INVALID");
  }
  const reserve = deps.reserve ?? reserveCreatorRenderIntentFromDatabase;
  const read = deps.read ?? readCreatorRenderIntentFromDatabase;
  const claims = deps.claims ?? new MysqlCreatorRenderClaims();
  const reservation = await reserve(input, trustedConfig, getDb, leaseSeconds);
  if (!reservation.created) return { ...reservation, dispatched: false as const };

  const scope: CreatorRenderClaimScope = {
    workspaceId: input.workspaceId,
    creatorProjectId: input.creatorProjectId,
    timelineId: input.timelineId,
    mode: input.verticalDerivativeOf === undefined ? "MASTER_CANDIDATE" : "VERTICAL_DERIVATIVE",
    fingerprint: reservation.fingerprint,
  };
  let lostLease = false;
  let heartbeatInFlight: Promise<void> | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  const heartbeat = async () => {
    if (heartbeatInFlight) return heartbeatInFlight;
    heartbeatInFlight = (async () => {
      try {
        if (!await claims.heartbeat(scope, reservation.leaseToken, leaseSeconds)) lostLease = true;
      } catch { lostLease = true; }
    })();
    try { await heartbeatInFlight; }
    finally { heartbeatInFlight = undefined; }
  };
  const stopHeartbeat = async () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
    if (heartbeatInFlight) await heartbeatInFlight;
  };
  const assertLease = () => {
    if (lostLease) throw new Error("CREATOR_RENDER_DISPATCH_LEASE_LOST");
  };

  try {
    const snapshot = await read(input, trustedConfig);
    if (snapshot.fingerprint !== reservation.fingerprint ||
        JSON.stringify(renderScope(snapshot.intent, snapshot.fingerprint)) !== JSON.stringify(scope)) {
      throw new Error("CREATOR_RENDER_DISPATCH_SOURCE_CHANGED");
    }
    const media = await (deps.resolveMedia ?? resolveTrustedCreatorRenderMedia)(snapshot.intent);
    await heartbeat();
    assertLease();
    heartbeatTimer = setInterval(() => { void heartbeat(); }, intervalMs);
    heartbeatTimer.unref?.();

    const intent = snapshot.intent;
    const rendered = await (deps.render ?? runCreatorRenderWorker)({
      workspaceId: intent.workspaceId,
      creatorProjectId: intent.creatorProjectId,
      timelineId: intent.timelineId,
      exportId: reservation.exportId,
      width: intent.output.width,
      height: intent.output.height,
      fps: intent.output.fps,
      fit: intent.output.fit,
      audioDurationMs: intent.audioMaster.durationMs,
      audioSourceUrl: media.audioSourceUrl,
      visualItems: media.visualItems,
      captions: [...intent.captions],
    }, deps.workerDependencies);

    await stopHeartbeat();
    assertLease();
    // Recheck before finalization; finalization must additionally enforce the
    // source row lock to eliminate the remaining post-check write race.
    const latest = await read(input, trustedConfig);
    if (latest.fingerprint !== reservation.fingerprint) {
      throw new Error("CREATOR_RENDER_DISPATCH_SOURCE_CHANGED");
    }
    await heartbeat();
    assertLease();
    const finalized = await claims.finalizeVerifiedExport(
      scope, reservation.leaseToken, reservation.exportId, rendered,
      deps.workerDependencies?.verifyArtifact,
    );
    return { ...finalized, claimId: reservation.claimId, dispatched: true as const };
  } catch (error) {
    // An uploaded artifact or timed-out process is ambiguous. Never requeue.
    try { await claims.markUnknown(scope, reservation.leaseToken); }
    catch { throw new Error("CREATOR_RENDER_DISPATCH_QUARANTINE_FAILED", { cause: error }); }
    throw error;
  } finally {
    await stopHeartbeat();
  }
}
