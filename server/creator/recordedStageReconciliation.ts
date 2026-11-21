import { and, asc, desc, eq, gt, isNotNull } from "drizzle-orm";
import { creatorArtifactLeases, creatorAssets, creatorGenerations, creatorProviderJobs } from "../../drizzle/schema";
import { getDb } from "../db";
import { isCreatorStagedObjectMissing, storageVerifySha256 } from "../storage";
import {
  classifyCreatorStagedArtifact, parseCreatorStagedKey,
  type StagedArtifactEvidence, type StagedArtifactFinding,
} from "./stagedArtifactInventory";

type RecordedStage = NonNullable<StagedArtifactEvidence["lease"]>;
type RecordedEvidence = Pick<StagedArtifactEvidence, "generation" | "latestJob" | "lease" | "assets">;
export type RecordedStageFinding = StagedArtifactFinding | "MISSING_OBJECT";

type RecordedStageDependencies = {
  loadPage: (workspaceId: number, afterGenerationId: number, limit: number) => Promise<RecordedStage[]>;
  loadEvidence: (stage: RecordedStage) => Promise<RecordedEvidence>;
  verify: typeof storageVerifySha256;
  isMissing: (error: unknown) => boolean;
};

async function requireDb() {
  const db = await getDb();
  if (!db) throw new Error("CREATOR_DATABASE_UNAVAILABLE");
  return db;
}

/** Database-first scan catches recorded stages absent from S3 LIST results. */
async function loadRecordedStagePage(workspaceId: number, afterGenerationId: number, limit: number) {
  const db = await requireDb();
  return db.select().from(creatorArtifactLeases).where(and(
    eq(creatorArtifactLeases.workspaceId, workspaceId),
    isNotNull(creatorArtifactLeases.stagedStorageKey),
    gt(creatorArtifactLeases.generationId, afterGenerationId),
  )).orderBy(asc(creatorArtifactLeases.generationId)).limit(limit);
}

async function loadRecordedStageEvidence(stage: RecordedStage): Promise<RecordedEvidence> {
  const db = await requireDb();
  const scope = and(
    eq(creatorGenerations.id, stage.generationId),
    eq(creatorGenerations.workspaceId, stage.workspaceId),
    eq(creatorGenerations.creatorProjectId, stage.creatorProjectId),
  );
  const [generations, jobs, assets] = await Promise.all([
    db.select().from(creatorGenerations).where(scope).limit(1),
    db.select().from(creatorProviderJobs).where(and(
      eq(creatorProviderJobs.workspaceId, stage.workspaceId),
      eq(creatorProviderJobs.creatorProjectId, stage.creatorProjectId),
      eq(creatorProviderJobs.generationId, stage.generationId),
    )).orderBy(desc(creatorProviderJobs.id)).limit(1),
    db.select().from(creatorAssets).where(eq(creatorAssets.storageKey, stage.stagedStorageKey ?? "")).limit(2),
  ]);
  return {
    generation: generations[0] ?? null,
    latestJob: jobs[0] ?? null,
    lease: stage,
    assets,
  };
}

/**
 * Read-only, bounded DB-first counterpart to inspectCreatorStagedInventory.
 * Missing is reported ONLY on a recognized S3 NoSuchKey, never on timeouts,
 * authorization failures, checksum mismatches or incomplete scans.
 * No lease recovery, deletion, paid-provider submission or DB mutation occurs.
 */
export async function inspectCreatorRecordedStages(input: {
  workspaceId: number;
  afterGenerationId?: number;
  maxRows?: number;
  nowMs?: number;
}, deps: RecordedStageDependencies = {
  loadPage: loadRecordedStagePage,
  loadEvidence: loadRecordedStageEvidence,
  verify: storageVerifySha256,
  isMissing: isCreatorStagedObjectMissing,
}): Promise<{
  workspaceId: number;
  scannedRecords: number;
  findings: Array<{ generationId: number; key: string; finding: RecordedStageFinding }>;
  complete: boolean;
  nextAfterGenerationId?: number;
}> {
  const after = input.afterGenerationId ?? 0;
  const maxRows = input.maxRows ?? 25;
  const nowMs = input.nowMs ?? Date.now();
  if (!Number.isSafeInteger(input.workspaceId) || input.workspaceId < 1)
    throw new Error("CREATOR_RECORDED_STAGE_WORKSPACE_INVALID");
  if (!Number.isSafeInteger(after) || after < 0)
    throw new Error("CREATOR_RECORDED_STAGE_CURSOR_INVALID");
  if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 100)
    throw new Error("CREATOR_RECORDED_STAGE_LIMIT_INVALID");
  if (!Number.isFinite(nowMs)) throw new Error("CREATOR_RECORDED_STAGE_TIME_INVALID");

  // The extra row proves pagination is incomplete; never claim a full scan
  // merely because the caller requested a small page.
  const rows = await deps.loadPage(input.workspaceId, after, maxRows + 1);
  if (rows.length > maxRows + 1) throw new Error("CREATOR_RECORDED_STAGE_PAGE_OVERFLOW");
  const complete = rows.length <= maxRows;
  const selected = rows.slice(0, maxRows);
  let previousId = after;
  const findings: Array<{ generationId: number; key: string; finding: RecordedStageFinding }> = [];
  for (const stage of selected) {
    if (stage.workspaceId !== input.workspaceId ||
        !Number.isSafeInteger(stage.generationId) || stage.generationId <= previousId)
      throw new Error("CREATOR_RECORDED_STAGE_PAGE_SCOPE_OR_ORDER_INVALID");
    previousId = stage.generationId;
    const key = stage.stagedStorageKey ?? "";
    const parsed = parseCreatorStagedKey(key);
    if (!parsed || parsed.workspaceId !== input.workspaceId ||
        parsed.creatorProjectId !== stage.creatorProjectId ||
        parsed.generationId !== stage.generationId) {
      findings.push({ generationId: stage.generationId, key, finding: "INVALID_STAGE_KEY" });
      continue;
    }
    const loaded = await deps.loadEvidence(stage);
    // Never trust a test seam or stale DB evidence to silently switch scope.
    if (!loaded.lease || loaded.lease.generationId !== stage.generationId ||
        loaded.lease.workspaceId !== stage.workspaceId ||
        loaded.lease.creatorProjectId !== stage.creatorProjectId ||
        loaded.lease.stagedStorageKey !== key)
      throw new Error("CREATOR_RECORDED_STAGE_EVIDENCE_SCOPE_MISMATCH");
    const evidence: StagedArtifactEvidence = {
      ...loaded,
      object: { key, sizeBytes: stage.stagedByteSize ?? 0 },
      nowMs, verified: "NOT_CHECKED",
    };
    let finding: RecordedStageFinding = classifyCreatorStagedArtifact(evidence);
    if (finding === "STORAGE_UNVERIFIED") {
      try {
        await deps.verify(key, stage.stagedByteSize ?? 0, parsed.checksumSha256);
        evidence.verified = "PASS";
        finding = classifyCreatorStagedArtifact(evidence);
      } catch (error) {
        // An active upload must not be treated as missing even if the S3 key
        // has not yet appeared. classifyCreatorStagedArtifact fences this first.
        finding = deps.isMissing(error) ? "MISSING_OBJECT" : "STORAGE_UNVERIFIED";
      }
    }
    findings.push({ generationId: stage.generationId, key, finding });
  }
  return {
    workspaceId: input.workspaceId,
    scannedRecords: selected.length,
    findings,
    complete,
    nextAfterGenerationId: complete ? undefined : previousId,
  };
}
