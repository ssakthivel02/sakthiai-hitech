import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/mysql2";
import { getDb } from "../db";
import { creatorRenderIntentFingerprint, type CreatorRenderIntentInput } from "./renderIntent";

/**
 * Review-only durable claim primitive. NO render dispatch integration.
 * InnoDB uniqueness serializes workers. An expired/ambiguous claim is quarantined
 * and can never launch a replacement without an independently reviewed reconciler.
 */
type Db = ReturnType<typeof drizzle>;
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
class ExistingRenderClaim extends Error {
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
   * ATOMIC pre-dispatch step. Unlike claim()+bindExport(), this either creates
   * one UNIQUE claim plus its QUEUED creatorExports row in the same transaction,
   * or creates neither. It does NOT schedule FFmpeg or authorize future retries.
   *
   * IMPORTANT: caller MUST collect an immutable, consistent media snapshot and
   * validate it inside a timeline-scoped lock before calling this method.
   * Runtime wiring, crash reconciliation and worker fencing are separate work.
   */
  async claimAndQueueExport(input: CreatorRenderIntentInput, leaseSeconds = 1800): Promise<CreatorRenderQueuedResult> {
    // Fingerprint validation is server-side and happens before any DB call.
    const { fingerprint, version } = creatorRenderIntentFingerprint(input);
    const scope = validateScope({
      workspaceId: input.workspaceId,
      creatorProjectId: input.creatorProjectId,
      timelineId: input.timelineId,
      mode: input.mode,
      fingerprint,
    });
    validLeaseSeconds(leaseSeconds);
    const db = await this.db();
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
      // Media signed URLs and private credentials must never enter this ledger.
    };
    try {
      return await db.transaction(async tx => {
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
        return { created: true, claimId, exportId, leaseToken, state: "RUNNING" as const, fingerprint };
      });
    } catch (error) {
      if (!(error instanceof ExistingRenderClaim)) throw error;
    }
    // Only after the unique insert's transaction resolves can a duplicate
    // read an authoritative exportId. Never hand out the worker's lease token.
    await this.quarantineExpired(scope, db);
    const existing = await this.read(db, scope);
    if (!existing) throw new Error("CREATOR_RENDER_CLAIM_DUPLICATE_NOT_FOUND");
    return {
      created: false, claimId: Number(existing.id), fingerprint,
      state: existing.state,
      exportId: existing.exportId === null ? null : Number(existing.exportId),
      outputAssetId: existing.outputAssetId === null ? null : Number(existing.outputAssetId),
    };
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
