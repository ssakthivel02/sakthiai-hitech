import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { creatorArtifactLeases, creatorGenerations, creatorProviderJobs } from "../../drizzle/schema";
import { getDb } from "../db";
import { assertCreatorArtifactJobOwnership } from "./artifactJobOwnership";

export const CREATOR_ARTIFACT_LEASE_MS = 10 * 60_000;

type ArtifactLeaseScope = {
  workspaceId: number;
  creatorProjectId: number;
  generationId: number;
  provider: string;
  providerJobId: string;
};

async function requireDb() {
  const db = await getDb();
  if (!db) throw new Error("CREATOR_DATABASE_UNAVAILABLE");
  return db;
}

/**
 * Serialize the claim on the generation row (the same row used by provider
 * submission, polling, and asset finalization). A lease never submits or
 * retries a provider generation. Only artifact retrieval/storage is fenced.
 */
export async function acquireCreatorArtifactLease(scope: ArtifactLeaseScope): Promise<string> {
  const db = await requireDb();
  return db.transaction(async tx => {
    const [generation] = await tx.select().from(creatorGenerations)
      .where(and(
        eq(creatorGenerations.id, scope.generationId),
        eq(creatorGenerations.workspaceId, scope.workspaceId),
        eq(creatorGenerations.creatorProjectId, scope.creatorProjectId),
      )).limit(1).for("update");
    if (!generation) throw new Error("CREATOR_GENERATION_NOT_FOUND");
    if (generation.provider !== scope.provider) throw new Error("CREATOR_ARTIFACT_PROVIDER_JOB_MISMATCH");
    if (generation.outputAssetId !== null) throw new Error("CREATOR_ARTIFACT_ALREADY_FINALIZED");

    const [job] = await tx.select().from(creatorProviderJobs)
      .where(and(
        eq(creatorProviderJobs.workspaceId, scope.workspaceId),
        eq(creatorProviderJobs.creatorProjectId, scope.creatorProjectId),
        eq(creatorProviderJobs.generationId, scope.generationId),
      )).orderBy(desc(creatorProviderJobs.id)).limit(1).for("update");
    assertCreatorArtifactJobOwnership({ ...scope, job: job ?? null });

    const [existing] = await tx.select().from(creatorArtifactLeases)
      .where(eq(creatorArtifactLeases.generationId, scope.generationId))
      .limit(1).for("update");
    const now = Date.now();
    if (existing && new Date(existing.leaseUntil).getTime() > now) {
      throw new Error("CREATOR_ARTIFACT_LEASE_BUSY");
    }

    const leaseToken = randomUUID();
    const leaseUntil = new Date(now + CREATOR_ARTIFACT_LEASE_MS);
    if (existing) {
      await tx.update(creatorArtifactLeases).set({
        workspaceId: scope.workspaceId,
        creatorProjectId: scope.creatorProjectId,
        providerJobId: scope.providerJobId,
        leaseToken,
        leaseUntil,
      }).where(eq(creatorArtifactLeases.generationId, scope.generationId));
    } else {
      await tx.insert(creatorArtifactLeases).values({
        workspaceId: scope.workspaceId,
        creatorProjectId: scope.creatorProjectId,
        generationId: scope.generationId,
        providerJobId: scope.providerJobId,
        leaseToken,
        leaseUntil,
      });
    }
    return leaseToken;
  });
}

/** Check again after potentially slow provider retrieval and before upload. */
export async function assertCreatorArtifactLeaseActive(scope: ArtifactLeaseScope, leaseToken: string): Promise<void> {
  const db = await requireDb();
  const [lease] = await db.select().from(creatorArtifactLeases)
    .where(and(
      eq(creatorArtifactLeases.generationId, scope.generationId),
      eq(creatorArtifactLeases.workspaceId, scope.workspaceId),
      eq(creatorArtifactLeases.creatorProjectId, scope.creatorProjectId),
    )).limit(1);
  if (!lease || lease.leaseToken !== leaseToken || lease.providerJobId !== scope.providerJobId ||
      new Date(lease.leaseUntil).getTime() <= Date.now()) {
    throw new Error("CREATOR_ARTIFACT_LEASE_LOST");
  }
}

/** A stale worker must never release a newer worker's lease. */
export async function releaseCreatorArtifactLease(scope: ArtifactLeaseScope, leaseToken: string): Promise<void> {
  const db = await requireDb();
  await db.delete(creatorArtifactLeases).where(and(
    eq(creatorArtifactLeases.generationId, scope.generationId),
    eq(creatorArtifactLeases.workspaceId, scope.workspaceId),
    eq(creatorArtifactLeases.creatorProjectId, scope.creatorProjectId),
    eq(creatorArtifactLeases.leaseToken, leaseToken),
  ));
}
