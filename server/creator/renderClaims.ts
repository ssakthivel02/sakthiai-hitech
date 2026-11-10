import { randomUUID } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/mysql2";
import { getDb } from "../db";
import { storageVerifySha256 } from "../storage";
import type { CreatorDbRenderIntentInput, TrustedCreatorRendererConfig } from "./renderIntentDb";
import { creatorRenderIntentFingerprint, type CreatorRenderIntentInput } from "./renderIntent";

/**
 * Review-only durable claim primitive. NO render dispatch integration.
 * InnoDB uniqueness serializes workers. An expired/ambiguous claim is quarantined
 * and can never launch a replacement without an independently reviewed reconciler.
 */
type Db = ReturnType<typeof drizzle>;
/** Minimal SQL surface shared by Drizzle MySQL transactions. */
export type CreatorRenderSqlTransaction = { execute(query: SQL): Promise<unknown> };
export type CreatorRenderClaimDbProvider = () => Promise<Db | null | undefined>;
export type CreatorRenderMode = "MASTER_CANDIDATE" | "VERTICAL_DERIVATIVE";
export type CreatorRenderClaimState = "RUNNING" | "SUCCEEDED" | "NEEDS_RECONCILIATION";
export type CreatorRenderClaimScope = {
  workspaceId: number; creatorProjectId: number; timelineId: number;
  mode: CreatorRenderMode; fingerprint: string;
};
export type CreatorRenderClaimResult =
  | { created: true; claimId: number; state: "RUNNING"; leaseToken: string }
  | { created: false; claimId: number; state: CreatorRenderClaimState; exportId: number | null; outputAssetId: number | null };
type ClaimRow = { id: number; state: CreatorRenderClaimState; exportId: number | null; outputAssetId: number | null };

/** Atomic phase-3 queue reservation. It does not authorize or start any FFmpeg worker. */
export type CreatorRenderQueuedResult =
  | { created: true; claimId: number; exportId: number; leaseToken: string; state: "RUNNING"; fingerprint: string }
  | { created: false; claimId: number; exportId: number | null; outputAssetId: number | null; state: CreatorRenderClaimState; fingerprint: string };
export class ExistingRenderClaim extends Error {
  constructor() { super("CREATOR_RENDER_CLAIM_EXISTS"); }
}

function validateScope(scope: CreatorRenderClaimScope): CreatorRenderClaimScope {
  for (const field of ["workspaceId", "creatorProjectId", "timelineId"] as const) {
    if (!Number.isSafeInteger(scope[field]) || scope[field] <= 0) throw new Error("CREATOR_RENDER_CLAIM_SCOPE_INVALID");
  }
  if (scope.mode !== "MASTER_CANDIDATE" && scope.mode !== "VERTICAL_DERIVATIVE") {
    throw new Error("CREATOR_RENDER_CLAIM_MODE_INVALID");
  }
  if (typeof scope.fingerprint !== "string" || !/^[0-9a-fA-F]{64}$/.test(scope.fingerprint)) {
    throw new Error("CREATOR_RENDER_CLAIM_FINGERPRINT_INVALID");
  }
  return { ...scope, fingerprint: scope.fingerprint.toLowerCase() };
}
function positiveInt(id: number) {
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("CREATOR_RENDER_CLAIM_ID_INVALID");
}
function validLeaseSeconds(seconds: number) {
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 1800) throw new Error("CREATOR_RENDER_CLAIM_LEASE_INVALID");
}
function rowsOf<T>(result: unknown): T[] {
  return Array.isArray(result) && Array.isArray(result[0]) ? result[0] as T[] : [];
}
function affected(result: unknown): number {
  return Array.isArray(result) ? Number((result[0] as { affectedRows?: number } | undefined)?.affectedRows ?? 0) : 0;
}
function lastInsertId(result: unknown): number {
  return Array.isArray(result) ? Number((result[0] as { insertId?: number } | undefined)?.insertId ?? 0) : 0;
}
function duplicateKey(error: unknown): boolean {
  for (let e: unknown = error, i = 0; i < 5 && e && typeof e === "object"; i++) {
    const value = e as { errno?: unknown; code?: unknown; cause?: unknown };
    if (value.errno === 1062 || value.code === "ER_DUP_ENTRY") return true;
    e = value.cause;
  }
  return false;
}

export class MysqlCreatorRenderClaims {
  constructor(private readonly provider: CreatorRenderClaimDbProvider = getDb) {}
  private async db() {
    const db = await this.provider();
    if (!db) throw new Error("CREATOR_RENDER_CLAIM_DATABASE_UNAVAILABLE");
    return db;
  }
  private async read(db: Db, scope: CreatorRenderClaimScope): Promise<ClaimRow | undefined> {
    const result = await db.execute(sql`
      SELECT id, state, exportId, outputAssetId FROM creatorRenderClaims
      WHERE workspaceId = ${scope.workspaceId} AND creatorProjectId = ${scope.creatorProjectId}
        AND timelineId = ${scope.timelineId} AND mode = ${scope.mode}
        AND fingerprint = ${scope.fingerprint} LIMIT 1
    `);
    return rowsOf<ClaimRow>(result)[0];
  }


  /**
   * Execute the claim + QUEUED export reservation on the caller's transaction.
   * The caller MUST already hold the scoped creatorTimelines FOR UPDATE lock,
   * and MUST derive the intent from source rows read on that same transaction.
   * This method never commits, signs URLs, starts FFmpeg, or returns a worker
   * token for an existing claim.
   */
  async reserveInsideTransaction(
    tx: CreatorRenderSqlTransaction,
    input: CreatorRenderIntentInput,
    leaseSeconds = 1800,
  ): Promise<Extract<CreatorRenderQueuedResult, { created: true }>> {
    const { fingerprint, version } = creatorRenderIntentFingerprint(input);
    const scope = validateScope({
      workspaceId: input.workspaceId,
      creatorProjectId: input.creatorProjectId,
      timelineId: input.timelineId,
      mode: input.mode,
      fingerprint,
    });
    validLeaseSeconds(leaseSeconds);
    const leaseToken = randomUUID();
    const snapshot = {
      intentVersion: version,
      intentFingerprint: fingerprint,
      mode: input.mode,
      audioMasterAssetId: input.audioMaster.assetId,
      audioMasterChecksumSha256: input.audioMaster.checksumSha256.toLowerCase(),
      durationMs: input.audioMaster.durationMs,
      visualAssetIds: input.visuals.map(x => x.assetId),
      visualCount: input.visuals.length,
      captionCueCount: input.captions.length,
      rendererVersion: input.output.rendererVersion,
      fontFamily: input.output.fontFamily,
      fit: input.output.fit,
      fps: input.output.fps,
      derivativeOfRenderAssetId: input.derivativeOf?.assetId ?? null,
      derivativeOfChecksumSha256: input.derivativeOf?.checksumSha256.toLowerCase() ?? null,
    };

    let claimId: number;
    try {
      const inserted = await tx.execute(sql`
        INSERT INTO creatorRenderClaims
          (workspaceId, creatorProjectId, timelineId, mode, fingerprint, leaseToken, leaseUntil, state)
        VALUES (${scope.workspaceId}, ${scope.creatorProjectId}, ${scope.timelineId}, ${scope.mode},
          ${fingerprint}, ${leaseToken},
          DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ${leaseSeconds} SECOND), 'RUNNING')
      `);
      claimId = lastInsertId(inserted);
      if (!claimId) throw new Error("CREATOR_RENDER_CLAIM_INSERT_INVALID");
    } catch (error) {
      if (duplicateKey(error)) throw new ExistingRenderClaim();
      throw error;
    }

    const exported = await tx.execute(sql`
      INSERT INTO creatorExports
        (workspaceId, creatorProjectId, timelineId, status, width, height,
         format, renderer, parametersJson)
      VALUES (${scope.workspaceId}, ${scope.creatorProjectId}, ${scope.timelineId},
        'QUEUED', ${input.output.width}, ${input.output.height},
        'mp4', 'ffmpeg', ${JSON.stringify(snapshot)})
    `);
    const exportId = lastInsertId(exported);
    if (!exportId) throw new Error("CREATOR_RENDER_EXPORT_CREATE_FAILED");

    const bound = await tx.execute(sql`
      UPDATE creatorRenderClaims SET exportId = ${exportId}
      WHERE id = ${claimId} AND workspaceId = ${scope.workspaceId}
        AND creatorProjectId = ${scope.creatorProjectId} AND timelineId = ${scope.timelineId}
        AND mode = ${scope.mode} AND fingerprint = ${fingerprint}
        AND leaseToken = ${leaseToken} AND state = 'RUNNING'
        AND leaseUntil > UTC_TIMESTAMP(3) AND exportId IS NULL
    `);
    if (affected(bound) !== 1) throw new Error("CREATOR_RENDER_CLAIM_BIND_FAILED");
    return { created: true, claimId, exportId, leaseToken, state: "RUNNING", fingerprint };
  }

  /** Duplicate lookup happens only AFTER the failed unique insert rolls back. */
  async resolveDuplicate(scopeInput: CreatorRenderClaimScope): Promise<Extract<CreatorRenderQueuedResult, { created: false }>> {
    const scope = validateScope(scopeInput);
    const db = await this.db();
    await this.quarantineExpired(scope, db);
    const existing = await this.read(db, scope);
    if (!existing) throw new Error("CREATOR_RENDER_CLAIM_DUPLICATE_NOT_FOUND");
    return {
      created: false, claimId: Number(existing.id), fingerprint: scope.fingerprint,
      state: existing.state,
      exportId: existing.exportId === null ? null : Number(existing.exportId),
      outputAssetId: existing.outputAssetId === null ? null : Number(existing.outputAssetId),
    };
  }

  /**
   * Legacy input-driven reservation remains available to existing tests, but
   * must not be wired to the production renderer. Use the database-derived
   * same-transaction reservation from renderIntentDb.ts for runtime work.
   */
  async claimAndQueueExport(input: CreatorRenderIntentInput, leaseSeconds = 1800): Promise<CreatorRenderQueuedResult> {
    const { fingerprint } = creatorRenderIntentFingerprint(input);
    const scope = validateScope({
      workspaceId: input.workspaceId,
      creatorProjectId: input.creatorProjectId,
      timelineId: input.timelineId,
      mode: input.mode,
      fingerprint,
    });
    validLeaseSeconds(leaseSeconds);
    const db = await this.db();
    try {
      return await db.transaction(tx => this.reserveInsideTransaction(tx, input, leaseSeconds));
    } catch (error) {
      if (!(error instanceof ExistingRenderClaim)) throw error;
    }
    return this.resolveDuplicate(scope);
  }

  /** Only created:true authorizes a FUTURE caller to start rendering. */
  async claim(input: CreatorRenderClaimScope, leaseSeconds = 1800): Promise<CreatorRenderClaimResult> {
    const scope = validateScope(input);
    validLeaseSeconds(leaseSeconds);
    const db = await this.db();
    const leaseToken = randomUUID();
    try {
      const result = await db.execute(sql`
        INSERT INTO creatorRenderClaims
          (workspaceId, creatorProjectId, timelineId, mode, fingerprint, leaseToken, leaseUntil, state)
        VALUES (${scope.workspaceId}, ${scope.creatorProjectId}, ${scope.timelineId}, ${scope.mode},
          ${scope.fingerprint}, ${leaseToken},
          DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ${leaseSeconds} SECOND), 'RUNNING')
      `);
      const claimId = lastInsertId(result);
      if (!claimId) throw new Error("CREATOR_RENDER_CLAIM_INSERT_INVALID");
      return { created: true, claimId, state: "RUNNING", leaseToken };
    } catch (error) {
      if (!duplicateKey(error)) throw error;
    }
    // Do not return a token or restart work for a duplicate, even if timed out.
    await this.quarantineExpired(scope, db);
    const existing = await this.read(db, scope);
    if (!existing) throw new Error("CREATOR_RENDER_CLAIM_DUPLICATE_NOT_FOUND");
    return {
      created: false,
      claimId: Number(existing.id), state: existing.state,
      exportId: existing.exportId === null ? null : Number(existing.exportId),
      outputAssetId: existing.outputAssetId === null ? null : Number(existing.outputAssetId),
    };
  }

  /**
   * Owner-facing durable status polling for a previously reserved render.
   * Never exposes the worker lease token, signed media URL or internal keys.
   * An expired lease is quarantined, not reacquired or automatically retried.
   */
  async pollClaim(input: {
    workspaceId: number; creatorProjectId: number; timelineId: number; claimId: number;
  }): Promise<{
    claimId: number; state: CreatorRenderClaimState; exportId: number | null;
    exportStatus: string | null; outputAssetId: number | null;
    requiresReconciliation: boolean; reviewRequired: boolean;
    finalMaster: false; publishApproved: false;
  }> {
    for (const key of ["workspaceId", "creatorProjectId", "timelineId", "claimId"] as const) {
      positiveInt(input[key]);
    }
    const db = await this.db();
    // State transition is scoped by owner, project, timeline and exact claim.
    // It fences a crashed worker without issuing another paid/render job.
    await db.execute(sql`
      UPDATE creatorRenderClaims SET state = 'NEEDS_RECONCILIATION'
      WHERE id = ${input.claimId} AND workspaceId = ${input.workspaceId}
        AND creatorProjectId = ${input.creatorProjectId} AND timelineId = ${input.timelineId}
        AND state = 'RUNNING' AND leaseUntil <= UTC_TIMESTAMP(3)
    `);
    const [row] = rowsOf<{
      id: number; state: CreatorRenderClaimState; exportId: number | null;
      outputAssetId: number | null; exportStatus: string | null;
    }>(await db.execute(sql`
      SELECT c.id, c.state, c.exportId, c.outputAssetId, e.status AS exportStatus
      FROM creatorRenderClaims c
      LEFT JOIN creatorExports e ON e.id = c.exportId
        AND e.workspaceId = c.workspaceId
        AND e.creatorProjectId = c.creatorProjectId
        AND e.timelineId = c.timelineId
      WHERE c.id = ${input.claimId} AND c.workspaceId = ${input.workspaceId}
        AND c.creatorProjectId = ${input.creatorProjectId}
        AND c.timelineId = ${input.timelineId} LIMIT 1
    `));
    if (!row) throw new Error("CREATOR_RENDER_CLAIM_NOT_FOUND");
    return {
      claimId: Number(row.id),
      state: row.state,
      exportId: row.exportId === null ? null : Number(row.exportId),
      exportStatus: row.exportStatus ?? null,
      outputAssetId: row.outputAssetId === null ? null : Number(row.outputAssetId),
      requiresReconciliation: row.state === "NEEDS_RECONCILIATION",
      reviewRequired: row.state === "SUCCEEDED",
      finalMaster: false,
      publishApproved: false,
    };
  }

  async heartbeat(input: CreatorRenderClaimScope, leaseToken: string, leaseSeconds = 1800): Promise<boolean> {
    const scope = validateScope(input);
    validLeaseSeconds(leaseSeconds);
    if (!/^[0-9a-f-]{36}$/i.test(leaseToken)) throw new Error("CREATOR_RENDER_CLAIM_TOKEN_INVALID");
    const db = await this.db();
    const result = await db.execute(sql`
      UPDATE creatorRenderClaims SET leaseUntil = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ${leaseSeconds} SECOND)
      WHERE workspaceId = ${scope.workspaceId} AND creatorProjectId = ${scope.creatorProjectId}
        AND timelineId = ${scope.timelineId} AND mode = ${scope.mode} AND fingerprint = ${scope.fingerprint}
        AND leaseToken = ${leaseToken} AND state = 'RUNNING' AND leaseUntil > UTC_TIMESTAMP(3)
    `);
    return affected(result) === 1;
  }

  /** Bind an existing export; creating its row/claim atomically is future integration work. */
  async bindExport(input: CreatorRenderClaimScope, leaseToken: string, exportId: number): Promise<boolean> {
    const scope = validateScope(input);
    positiveInt(exportId);
    const db = await this.db();
    const result = await db.execute(sql`
      UPDATE creatorRenderClaims SET exportId = ${exportId}
      WHERE workspaceId = ${scope.workspaceId} AND creatorProjectId = ${scope.creatorProjectId}
        AND timelineId = ${scope.timelineId} AND mode = ${scope.mode} AND fingerprint = ${scope.fingerprint}
        AND leaseToken = ${leaseToken} AND state = 'RUNNING' AND leaseUntil > UTC_TIMESTAMP(3)
        AND exportId IS NULL
    `);
    return affected(result) === 1;
  }

  /** Fenced completion. Caller must separately prove the persisted output/checksum. */
  async complete(input: CreatorRenderClaimScope, leaseToken: string, exportId: number, assetId: number, outputSha256: string): Promise<boolean> {
    const scope = validateScope(input);
    positiveInt(exportId); positiveInt(assetId);
    if (!/^[a-fA-F0-9]{64}$/.test(outputSha256)) throw new Error("CREATOR_RENDER_CLAIM_OUTPUT_CHECKSUM_INVALID");
    const db = await this.db();
    const result = await db.execute(sql`
      UPDATE creatorRenderClaims
      SET state = 'SUCCEEDED', outputAssetId = ${assetId},
        outputChecksumSha256 = ${outputSha256.toLowerCase()}, completedAt = UTC_TIMESTAMP(3)
      WHERE workspaceId = ${scope.workspaceId} AND creatorProjectId = ${scope.creatorProjectId}
        AND timelineId = ${scope.timelineId} AND mode = ${scope.mode} AND fingerprint = ${scope.fingerprint}
        AND leaseToken = ${leaseToken} AND exportId = ${exportId}
        AND state = 'RUNNING' AND leaseUntil > UTC_TIMESTAMP(3)
    `);
    return affected(result) === 1;
  }


  /**
   * Atomic, lease-fenced persistence of a storage-verified FFmpeg result.
   * This is a finalization primitive, NOT a worker dispatcher. The caller
   * must already have rendered under a newly-created reservation token.
   * Readback is performed before the DB transaction; the lease is rechecked
   * under FOR UPDATE afterwards. The source timeline lock and fingerprint
   * are checked inside that same transaction, preventing stale-caption commits.
   * Failed or expired fences create NO asset.
   */
  async finalizeVerifiedExport(
    scopeInput: CreatorRenderClaimScope,
    leaseToken: string,
    exportId: number,
    output: {
      storageKey: string; checksumSha256: string; byteSize: number;
      width: number; height: number; fps: number; durationMs: number;
      frameCount: number; visualAssetIds: number[]; renderer: "ffmpeg";
      outputEvidence?: { width: number; height: number; fps: number; durationSeconds: number; hasAudio: boolean };
    },
    sourceInput: CreatorDbRenderIntentInput,
    trustedConfig: TrustedCreatorRendererConfig,
    verifyArtifact: (key: string, size: number, checksumSha256: string) => Promise<void> = storageVerifySha256,
  ): Promise<{ assetId: number; exportId: number; reviewDecision: "PENDING" }> {
    const scope = validateScope(scopeInput);
    positiveInt(exportId);
    // Finalization must be derived from the same server-owned source scope.
    if (!sourceInput || sourceInput.workspaceId !== scope.workspaceId ||
        sourceInput.creatorProjectId !== scope.creatorProjectId ||
        sourceInput.timelineId !== scope.timelineId ||
        (scope.mode === "MASTER_CANDIDATE" && sourceInput.verticalDerivativeOf !== undefined) ||
        (scope.mode === "VERTICAL_DERIVATIVE" && sourceInput.verticalDerivativeOf === undefined)) {
      throw new Error("CREATOR_RENDER_FINALIZE_SOURCE_SCOPE_INVALID");
    }
    if (!/^[0-9a-f-]{36}$/i.test(leaseToken)) throw new Error("CREATOR_RENDER_CLAIM_TOKEN_INVALID");
    const expectedKey = `creator/${scope.workspaceId}/${scope.creatorProjectId}/renders/timeline-${scope.timelineId}/export-${exportId}.mp4`;
    if (output.storageKey !== expectedKey || output.renderer !== "ffmpeg") throw new Error("CREATOR_RENDER_OUTPUT_IDENTITY_INVALID");
    if (!/^[a-f0-9]{64}$/i.test(output.checksumSha256)) throw new Error("CREATOR_RENDER_OUTPUT_CHECKSUM_INVALID");
    if (!Number.isSafeInteger(output.byteSize) || output.byteSize <= 0 || output.byteSize > 1024 * 1024 * 1024 ||
        ![output.width, output.height, output.fps, output.durationMs, output.frameCount].every(
          n => Number.isSafeInteger(n) && n > 0
        ) || !Array.isArray(output.visualAssetIds) || !output.visualAssetIds.length ||
        !output.visualAssetIds.every(n => Number.isSafeInteger(n) && n > 0)) {
      throw new Error("CREATOR_RENDER_OUTPUT_METADATA_INVALID");
    }

    if (output.outputEvidence && (
      output.outputEvidence.width !== output.width || output.outputEvidence.height !== output.height ||
      Math.abs(output.outputEvidence.fps - output.fps) > 0.01 ||
      Math.abs(output.outputEvidence.durationSeconds * 1000 - output.durationMs) > 100 ||
      output.outputEvidence.hasAudio !== true
    )) throw new Error("CREATOR_RENDER_OUTPUT_PROBE_DRIFT");

    // A successful upload is NOT evidence of durable bytes. Do not insert
    // the asset or complete the claim until the stored bytes are verified.
    await verifyArtifact(output.storageKey, output.byteSize, output.checksumSha256.toLowerCase());
    // Take the SAME timeline row lock as caption/timeline writers, and derive
    // the current source fingerprint while that lock is held. Keep it held
    // through the claim/export/asset commit; no post-check writer can slip in.
    const { withCreatorRenderIntentTransaction } = await import("./renderIntentDb");
    return withCreatorRenderIntentTransaction(sourceInput, trustedConfig, async (tx, current) => {
      if (current.fingerprint !== scope.fingerprint || current.intent.mode !== scope.mode) {
        throw new Error("CREATOR_RENDER_FINALIZE_SOURCE_DRIFT");
      }
      const [claim] = rowsOf<{ id: number }>(await tx.execute(sql`
        SELECT id FROM creatorRenderClaims
        WHERE workspaceId = ${scope.workspaceId} AND creatorProjectId = ${scope.creatorProjectId}
          AND timelineId = ${scope.timelineId} AND mode = ${scope.mode}
          AND fingerprint = ${scope.fingerprint} AND leaseToken = ${leaseToken}
          AND exportId = ${exportId} AND state = 'RUNNING'
          AND leaseUntil > UTC_TIMESTAMP(3) FOR UPDATE
      `));
      if (!claim) throw new Error("CREATOR_RENDER_FINALIZE_FENCE_LOST");

      const [queued] = rowsOf<{
        id: number; status: string; assetId: number | null; parametersJson: string | null;
        width: number; height: number;
      }>(await tx.execute(sql`
        SELECT id, status, assetId, parametersJson, width, height FROM creatorExports
        WHERE id = ${exportId} AND workspaceId = ${scope.workspaceId}
          AND creatorProjectId = ${scope.creatorProjectId} AND timelineId = ${scope.timelineId}
        FOR UPDATE
      `));
      if (!queued || (queued.status !== "QUEUED" && queued.status !== "RUNNING") ||
          queued.assetId !== null || !queued.parametersJson) {
        throw new Error("CREATOR_RENDER_FINALIZE_EXPORT_INVALID");
      }
      let snapshot: {
        intentFingerprint?: string; mode?: string; audioMasterAssetId?: number;
        audioMasterChecksumSha256?: string; visualAssetIds?: number[];
        durationMs?: number; fps?: number; derivativeOfRenderAssetId?: number | null;
      };
      try { snapshot = JSON.parse(queued.parametersJson); }
      catch { throw new Error("CREATOR_RENDER_FINALIZE_SNAPSHOT_INVALID"); }
      if (snapshot.intentFingerprint !== scope.fingerprint || snapshot.mode !== scope.mode ||
          !Number.isSafeInteger(snapshot.audioMasterAssetId) ||
          !/^[a-f0-9]{64}$/i.test(snapshot.audioMasterChecksumSha256 ?? "") ||
          queued.width !== output.width || queued.height !== output.height ||
          snapshot.durationMs !== output.durationMs || snapshot.fps !== output.fps ||
          JSON.stringify(snapshot.visualAssetIds) !== JSON.stringify(output.visualAssetIds)) {
        throw new Error("CREATOR_RENDER_FINALIZE_SNAPSHOT_DRIFT");
      }

      const provenance = {
        source: scope.mode === "MASTER_CANDIDATE" ? "deterministic-creator-render" : "deterministic-creator-derivative",
        renderer: "ffmpeg", exportId, timelineId: scope.timelineId,
        intentFingerprint: scope.fingerprint, audioMasterAssetId: snapshot.audioMasterAssetId,
        audioMasterChecksumSha256: snapshot.audioMasterChecksumSha256,
        visualAssetIds: output.visualAssetIds, durationMs: output.durationMs,
        frameCount: output.frameCount, width: output.width, height: output.height,
        fps: output.fps, checksumSha256: output.checksumSha256.toLowerCase(),
        outputEvidence: output.outputEvidence ?? null,
        derivativeOfRenderAssetId: snapshot.derivativeOfRenderAssetId ?? null,
        renderedAt: new Date().toISOString(),
      };
      const inserted = await tx.execute(sql`
        INSERT INTO creatorAssets
          (workspaceId, creatorProjectId, assetType, mimeType, storageKey,
           checksumSha256, byteSize, immutable, provenanceJson, reviewDecision)
        VALUES (${scope.workspaceId}, ${scope.creatorProjectId}, 'RENDER', 'video/mp4',
          ${output.storageKey}, ${output.checksumSha256.toLowerCase()}, ${output.byteSize},
          1, ${JSON.stringify(provenance)}, 'PENDING')
      `);
      const assetId = lastInsertId(inserted);
      if (!assetId) throw new Error("CREATOR_RENDER_FINALIZE_ASSET_INSERT_FAILED");
      const exported = await tx.execute(sql`
        UPDATE creatorExports SET status = 'SUCCEEDED', assetId = ${assetId},
          checksumSha256 = ${output.checksumSha256.toLowerCase()}, completedAt = UTC_TIMESTAMP()
        WHERE id = ${exportId} AND workspaceId = ${scope.workspaceId}
          AND creatorProjectId = ${scope.creatorProjectId} AND timelineId = ${scope.timelineId}
          AND assetId IS NULL AND status IN ('QUEUED','RUNNING')
      `);
      if (affected(exported) !== 1) throw new Error("CREATOR_RENDER_FINALIZE_EXPORT_UPDATE_FAILED");
      const completed = await tx.execute(sql`
        UPDATE creatorRenderClaims SET state = 'SUCCEEDED', outputAssetId = ${assetId},
          outputChecksumSha256 = ${output.checksumSha256.toLowerCase()}, completedAt = UTC_TIMESTAMP()
        WHERE id = ${claim.id} AND workspaceId = ${scope.workspaceId}
          AND creatorProjectId = ${scope.creatorProjectId} AND timelineId = ${scope.timelineId}
          AND mode = ${scope.mode} AND fingerprint = ${scope.fingerprint}
          AND leaseToken = ${leaseToken} AND exportId = ${exportId}
          AND state = 'RUNNING' AND leaseUntil > UTC_TIMESTAMP(3)
      `);
      if (affected(completed) !== 1) throw new Error("CREATOR_RENDER_FINALIZE_FENCE_LOST");
      return { assetId, exportId, reviewDecision: "PENDING" as const };
    }, async () => this.db());
  }

  /** A timeout/crash/output ambiguity is a quarantine, never auto-retry. */
  async markUnknown(input: CreatorRenderClaimScope, leaseToken: string): Promise<boolean> {
    const scope = validateScope(input);
    const db = await this.db();
    const result = await db.execute(sql`
      UPDATE creatorRenderClaims SET state = 'NEEDS_RECONCILIATION'
      WHERE workspaceId = ${scope.workspaceId} AND creatorProjectId = ${scope.creatorProjectId}
        AND timelineId = ${scope.timelineId} AND mode = ${scope.mode} AND fingerprint = ${scope.fingerprint}
        AND leaseToken = ${leaseToken} AND state = 'RUNNING'
    `);
    return affected(result) === 1;
  }

  private async quarantineExpired(scope: CreatorRenderClaimScope, db: Db): Promise<void> {
    await db.execute(sql`
      UPDATE creatorRenderClaims SET state = 'NEEDS_RECONCILIATION'
      WHERE workspaceId = ${scope.workspaceId} AND creatorProjectId = ${scope.creatorProjectId}
        AND timelineId = ${scope.timelineId} AND mode = ${scope.mode} AND fingerprint = ${scope.fingerprint}
        AND state = 'RUNNING' AND leaseUntil <= UTC_TIMESTAMP(3)
    `);
  }
}
