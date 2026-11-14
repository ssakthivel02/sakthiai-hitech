import { and, desc, eq } from "drizzle-orm";
import { creatorArtifactLeases, creatorAssets, creatorGenerations, creatorProviderJobs } from "../../drizzle/schema";
import { getDb } from "../db";
import { storageListPage, storageVerifySha256 } from "../storage";
import {
  classifyCreatorStagedArtifact, isCreatorStagedCandidate, parseCreatorStagedKey,
  type StagedArtifactEvidence, type StagedArtifactFinding,
} from "./stagedArtifactInventory";

type InventoryObject = { key: string; sizeBytes: number; lastModified: Date | null };
type InventoryEvidence = Pick<StagedArtifactEvidence, "generation" | "latestJob" | "lease" | "assets">;

type InventoryDependencies = {
  list: typeof storageListPage;
  load: (key: string) => Promise<InventoryEvidence>;
  verify: typeof storageVerifySha256;
};

async function loadInventoryEvidence(key: string): Promise<InventoryEvidence> {
  const parsed = parseCreatorStagedKey(key);
  if (!parsed) throw new Error("CREATOR_INVENTORY_STAGE_KEY_INVALID");
  const db = await getDb();
  if (!db) throw new Error("CREATOR_DATABASE_UNAVAILABLE");
  const scope = and(
    eq(creatorGenerations.workspaceId, parsed.workspaceId),
    eq(creatorGenerations.creatorProjectId, parsed.creatorProjectId),
    eq(creatorGenerations.id, parsed.generationId),
  );
  const [generationRows, leaseRows, jobRows, assets] = await Promise.all([
    db.select().from(creatorGenerations).where(scope).limit(1),
    db.select().from(creatorArtifactLeases).where(and(
      eq(creatorArtifactLeases.workspaceId, parsed.workspaceId),
      eq(creatorArtifactLeases.creatorProjectId, parsed.creatorProjectId),
      eq(creatorArtifactLeases.generationId, parsed.generationId),
    )).limit(1),
    db.select().from(creatorProviderJobs).where(and(
      eq(creatorProviderJobs.workspaceId, parsed.workspaceId),
      eq(creatorProviderJobs.creatorProjectId, parsed.creatorProjectId),
      eq(creatorProviderJobs.generationId, parsed.generationId),
    )).orderBy(desc(creatorProviderJobs.id)).limit(1),
    // Check all references to the exact key, including a conflicting tenant.
    db.select().from(creatorAssets).where(eq(creatorAssets.storageKey, key)).limit(2),
  ]);
  return {
    generation: generationRows[0] ?? null,
    lease: leaseRows[0] ?? null,
    latestJob: jobRows[0] ?? null,
    assets,
  };
}

/**
 * Read-only operator inventory. Never deletes, re-submits generation, renews a
 * lease, or writes to MySQL. Results are observational snapshots, not cleanup
 * authorization. The continuation token is essential for a complete scan.
 */
export async function inspectCreatorStagedInventory(input: {
  workspaceId: number;
  maxKeys?: number;
  continuationToken?: string;
  nowMs?: number;
}, deps: InventoryDependencies = {
  list: storageListPage,
  load: loadInventoryEvidence,
  verify: storageVerifySha256,
}): Promise<{
  workspaceId: number;
  scannedObjects: number;
  skippedNonStaged: number;
  findings: Array<{ key: string; sizeBytes: number; finding: StagedArtifactFinding }>;
  complete: boolean;
  nextContinuationToken?: string;
}> {
  if (!Number.isSafeInteger(input.workspaceId) || input.workspaceId < 1) {
    throw new Error("CREATOR_INVENTORY_WORKSPACE_INVALID");
  }
  const maxKeys = input.maxKeys ?? 100;
  if (!Number.isSafeInteger(maxKeys) || maxKeys < 1 || maxKeys > 200) {
    throw new Error("CREATOR_INVENTORY_LIMIT_INVALID");
  }
  if (input.continuationToken !== undefined &&
      (!input.continuationToken || input.continuationToken.length > 2048)) {
    throw new Error("CREATOR_INVENTORY_CURSOR_INVALID");
  }
  const nowMs = input.nowMs ?? Date.now();
  if (!Number.isFinite(nowMs)) throw new Error("CREATOR_INVENTORY_TIME_INVALID");
  const prefix = `creator/${input.workspaceId}/`;
  const page = await deps.list(prefix, maxKeys, input.continuationToken);
  const findings: Array<{ key: string; sizeBytes: number; finding: StagedArtifactFinding }> = [];
  let skippedNonStaged = 0;
  for (const object of page.objects as InventoryObject[]) {
    // Defensive scope check even if the S3 backend ignores Prefix.
    if (!object.key.startsWith(prefix)) throw new Error("CREATOR_INVENTORY_STORAGE_SCOPE_MISMATCH");
    if (!isCreatorStagedCandidate(object.key)) {
      skippedNonStaged++;
      continue;
    }
    const parsed = parseCreatorStagedKey(object.key);
    if (!parsed || parsed.workspaceId !== input.workspaceId) {
      findings.push({ key: object.key, sizeBytes: object.sizeBytes, finding: "INVALID_STAGE_KEY" });
      continue;
    }
    const loaded = await deps.load(object.key);
    const evidence: StagedArtifactEvidence = {
      ...loaded, object, nowMs, verified: "NOT_CHECKED",
    };
    let finding = classifyCreatorStagedArtifact(evidence);
    if (finding === "STORAGE_UNVERIFIED") {
      try {
        await deps.verify(object.key, object.sizeBytes, parsed.checksumSha256);
        evidence.verified = "PASS";
      } catch {
        evidence.verified = "FAIL";
      }
      finding = classifyCreatorStagedArtifact(evidence);
    }
    findings.push({ key: object.key, sizeBytes: object.sizeBytes, finding });
  }
  if (page.isTruncated && !page.nextContinuationToken) {
    throw new Error("CREATOR_INVENTORY_INVALID_PAGE");
  }
  return {
    workspaceId: input.workspaceId,
    scannedObjects: page.objects.length,
    skippedNonStaged,
    findings,
    complete: !page.isTruncated,
    nextContinuationToken: page.nextContinuationToken,
  };
}
