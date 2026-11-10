import { sql } from "drizzle-orm";
import { getDb } from "../db";
import { CREATOR_CAPTION_FONT_FAMILY } from "./renderWorker";
import {
  dispatchQueuedCreatorRender,
  type CreatorQueuedRenderReservation,
} from "./renderDispatch";
import type { CreatorDbRenderIntentInput, TrustedCreatorRendererConfig } from "./renderIntentDb";

/**
 * A bounded, one-shot consumer of the EXISTING creatorRenderClaims/creatorExports
 * queue. No second queue, automatic retry, provider purchase or publishing.
 *
 * This function is deliberately not started by the web server. A supervised
 * worker entry point and its operational activation are separate owner gates.
 * All executions still acquire the same MySQL lease fence as the HTTP route.
 */
export type QueuedCreatorRenderRow = {
  claimId: number;
  exportId: number;
  workspaceId: number;
  creatorProjectId: number;
  timelineId: number;
  mode: "MASTER_CANDIDATE" | "VERTICAL_DERIVATIVE";
  fingerprint: string;
  parametersJson: string;
};

function positive(n: number): boolean {
  return Number.isSafeInteger(n) && n > 0;
}

export async function listQueuedCreatorRenders(
  limit = 4,
  dbProvider: typeof getDb = getDb,
): Promise<QueuedCreatorRenderRow[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 8) {
    throw new Error("CREATOR_RENDER_QUEUE_BATCH_LIMIT_INVALID");
  }
  const db = await dbProvider();
  if (!db) throw new Error("CREATOR_RENDER_QUEUE_DATABASE_UNAVAILABLE");
  // This is discovery, not ownership. The acquisition transaction in
  // dispatchQueuedCreatorRender is the only permission to launch FFmpeg.
  const result = await db.execute(sql`
    SELECT c.id AS claimId, c.exportId, c.workspaceId, c.creatorProjectId,
      c.timelineId, c.mode, c.fingerprint, e.parametersJson
    FROM creatorRenderClaims c
    INNER JOIN creatorExports e ON e.id = c.exportId
      AND e.workspaceId = c.workspaceId
      AND e.creatorProjectId = c.creatorProjectId
      AND e.timelineId = c.timelineId
    WHERE c.state = 'RUNNING' AND e.status = 'QUEUED'
      AND c.leaseUntil > UTC_TIMESTAMP(3)
    ORDER BY c.id ASC
    LIMIT ${limit}
  `);
  return Array.isArray(result) && Array.isArray(result[0])
    ? result[0] as QueuedCreatorRenderRow[]
    : [];
}

/**
 * Crash/lease-expiry reconciliation on the EXISTING claim table. A timed-out
 * RUNNING export may have written bytes already, so quarantine it; NEVER
 * requeue or regenerate it automatically. A renewed lease is protected by the
 * conditional UPDATE even when renewal races the initial discovery query.
 */
export async function quarantineExpiredCreatorRenderClaims(
  limit = 4,
  dbProvider: typeof getDb = getDb,
): Promise<number[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 8) {
    throw new Error("CREATOR_RENDER_QUEUE_BATCH_LIMIT_INVALID");
  }
  const db = await dbProvider();
  if (!db) throw new Error("CREATOR_RENDER_QUEUE_DATABASE_UNAVAILABLE");
  const result = await db.execute(sql`
    SELECT c.id AS claimId
    FROM creatorRenderClaims c
    INNER JOIN creatorExports e ON e.id = c.exportId
      AND e.workspaceId = c.workspaceId
      AND e.creatorProjectId = c.creatorProjectId
      AND e.timelineId = c.timelineId
    WHERE c.state = 'RUNNING' AND c.leaseUntil <= UTC_TIMESTAMP(3)
      AND e.status IN ('QUEUED', 'RUNNING')
    ORDER BY c.id ASC
    LIMIT ${limit}
  `);
  const rows = Array.isArray(result) && Array.isArray(result[0])
    ? result[0] as Array<{ claimId: number }> : [];
  const quarantined: number[] = [];
  for (const row of rows) {
    if (!positive(row.claimId)) throw new Error("CREATOR_RENDER_QUEUE_ROW_INVALID");
    const updated = await db.execute(sql`
      UPDATE creatorRenderClaims SET state = 'NEEDS_RECONCILIATION'
      WHERE id = ${row.claimId} AND state = 'RUNNING'
        AND leaseUntil <= UTC_TIMESTAMP(3)
    `);
    const header = Array.isArray(updated)
      ? updated[0] as { affectedRows?: number } : undefined;
    if (header?.affectedRows === 1) quarantined.push(row.claimId);
  }
  return quarantined;
}

function trustedQueuedRequest(row: QueuedCreatorRenderRow): {
  input: CreatorDbRenderIntentInput;
  config: TrustedCreatorRendererConfig;
  reservation: CreatorQueuedRenderReservation;
} {
  if (![row.claimId, row.exportId, row.workspaceId, row.creatorProjectId, row.timelineId].every(positive) ||
      !/^[a-f0-9]{64}$/.test(row.fingerprint) ||
      (row.mode !== "MASTER_CANDIDATE" && row.mode !== "VERTICAL_DERIVATIVE")) {
    throw new Error("CREATOR_RENDER_QUEUE_ROW_INVALID");
  }
  let snapshot: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(row.parametersJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
    snapshot = parsed as Record<string, unknown>;
  } catch {
    throw new Error("CREATOR_RENDER_QUEUE_SNAPSHOT_INVALID");
  }
  if (snapshot.intentFingerprint !== row.fingerprint || snapshot.mode !== row.mode ||
      snapshot.rendererVersion !== "ffmpeg-v1" ||
      snapshot.fontFamily !== CREATOR_CAPTION_FONT_FAMILY) {
    throw new Error("CREATOR_RENDER_QUEUE_SNAPSHOT_DRIFT");
  }
  const derivativeId = snapshot.derivativeOfRenderAssetId;
  if (row.mode === "MASTER_CANDIDATE" && derivativeId != null) {
    throw new Error("CREATOR_RENDER_QUEUE_DERIVATIVE_INVALID");
  }
  if (row.mode === "VERTICAL_DERIVATIVE" && !positive(derivativeId as number)) {
    throw new Error("CREATOR_RENDER_QUEUE_DERIVATIVE_INVALID");
  }
  return {
    input: {
      workspaceId: row.workspaceId,
      creatorProjectId: row.creatorProjectId,
      timelineId: row.timelineId,
      ...(row.mode === "VERTICAL_DERIVATIVE"
        ? { verticalDerivativeOf: derivativeId as number }
        : {}),
    },
    config: { rendererVersion: "ffmpeg-v1", fontFamily: CREATOR_CAPTION_FONT_FAMILY },
    reservation: { claimId: row.claimId, exportId: row.exportId, fingerprint: row.fingerprint },
  };
}

export type CreatorQueueBatchResult = {
  attempted: number;
  dispatched: number;
  skipped: number;
  failed: number;
  interrupted: boolean;
  results: Array<{
    claimId: number;
    outcome: "DISPATCHED" | "LOST_ACQUISITION" | "FAILED";
    code?: string;
  }>;
};

export type CreatorQueueBatchDependencies = {
  env?: Record<string, string | undefined>;
  /** Supervisor cancellation: stop scanning; active default dispatch aborts FFmpeg. */
  abortSignal?: AbortSignal;
  load?: (limit: number) => Promise<QueuedCreatorRenderRow[]>;
  dispatch?: (
    input: CreatorDbRenderIntentInput,
    config: TrustedCreatorRendererConfig,
    reservation: CreatorQueuedRenderReservation,
  ) => Promise<unknown>;
};

/** One bounded pass; no timer, retry loop, self-scheduling or automatic requeue. */
export async function runCreatorRenderQueueBatch(
  limit = 4,
  deps: CreatorQueueBatchDependencies = {},
): Promise<CreatorQueueBatchResult> {
  if ((deps.env ?? process.env).CREATOR_ASYNC_RENDER_WORKER_ENABLED !== "true") {
    throw new Error("CREATOR_RENDER_ASYNC_WORKER_DISABLED");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 8) {
    throw new Error("CREATOR_RENDER_QUEUE_BATCH_LIMIT_INVALID");
  }
  if (deps.abortSignal?.aborted) throw new Error("CREATOR_RENDER_WORKER_STOP_REQUESTED");
  const rows = await (deps.load ?? listQueuedCreatorRenders)(limit);
  if (rows.length > limit) throw new Error("CREATOR_RENDER_QUEUE_SCAN_OVERSIZED");
  const seen = new Set<number>();
  const results: CreatorQueueBatchResult["results"] = [];
  let dispatched = 0;
  let skipped = 0;
  let failed = 0;
  let interrupted = false;
  for (const row of rows) {
    if (deps.abortSignal?.aborted) { interrupted = true; break; }
    if (seen.has(row.claimId)) continue;
    seen.add(row.claimId);
    try {
      const request = trustedQueuedRequest(row);
      if (deps.dispatch) {
        await deps.dispatch(request.input, request.config, request.reservation);
      } else {
        await dispatchQueuedCreatorRender(
          request.input, request.config, request.reservation,
          { abortSignal: deps.abortSignal },
        );
      }
      dispatched++;
      results.push({ claimId: row.claimId, outcome: "DISPATCHED" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message === "CREATOR_RENDER_DISPATCH_WORKER_NOT_ACQUIRED") {
        skipped++;
        results.push({ claimId: row.claimId, outcome: "LOST_ACQUISITION" });
      } else {
        failed++;
        // Never leak storage URLs, tokens, SQL text or provider diagnostics.
        const code = /^CREATOR_[A-Z0-9_]+$/.test(message)
          ? message : "CREATOR_RENDER_QUEUE_EXECUTION_FAILED";
        results.push({ claimId: row.claimId, outcome: "FAILED", code });
      }
      if (deps.abortSignal?.aborted) { interrupted = true; break; }
    }
  }
  return { attempted: results.length, dispatched, skipped, failed, interrupted, results };
}
