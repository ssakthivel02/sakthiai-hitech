import {
  creatorAssets,
  creatorCaptionCues,
  creatorExports,
  creatorGenerations,
  creatorProjects,
  creatorProviderJobs,
  creatorReferences,
  creatorReviews,
  creatorScenes,
  creatorShots,
  creatorTimelineItems,
  creatorTimelines,
} from "../../drizzle/schema";
import { getDb } from "../db";
import { storageRoundTripProbe } from "../storage";
import { buildCreatorRuntimePreflight, type CreatorPreflightCheck } from "./runtimePreflight";

export type CreatorRuntimeAcceptance = {
  readyForPaidGeneration: boolean;
  productionApproved: false;
  checks: CreatorPreflightCheck[];
};

type AcceptanceDeps = {
  configuration?: ReturnType<typeof buildCreatorRuntimePreflight>;
  databaseProbe?: () => Promise<{ pass: boolean; detail: string }>;
  storageProbe?: () => Promise<{ pass: boolean; detail: string }>;
};

async function probeCreatorDatabase(): Promise<{ pass: boolean; detail: string }> {
  try {
    const db = await getDb();
    if (!db) return { pass: false, detail: "Creator database connection is unavailable." };

    // Fail closed on the complete P0 Creator schema. A partial migration must never
    // unlock paid generation just because project/asset tables happen to exist.
    await Promise.all([
      db.select({ id: creatorProjects.id }).from(creatorProjects).limit(1),
      db.select({ id: creatorScenes.id }).from(creatorScenes).limit(1),
      db.select({ id: creatorShots.id }).from(creatorShots).limit(1),
      db.select({ id: creatorAssets.id }).from(creatorAssets).limit(1),
      db.select({ id: creatorReferences.id }).from(creatorReferences).limit(1),
      db.select({ id: creatorGenerations.id }).from(creatorGenerations).limit(1),
      db.select({ id: creatorProviderJobs.id }).from(creatorProviderJobs).limit(1),
      db.select({ id: creatorTimelines.id }).from(creatorTimelines).limit(1),
      db.select({ id: creatorTimelineItems.id }).from(creatorTimelineItems).limit(1),
      db.select({ id: creatorCaptionCues.id }).from(creatorCaptionCues).limit(1),
      db.select({ id: creatorReviews.id }).from(creatorReviews).limit(1),
      db.select({ id: creatorExports.id }).from(creatorExports).limit(1),
    ]);

    return {
      pass: true,
      detail: "Creator database connection and complete P0 project/scene/shot/asset/reference/generation/job/timeline/caption/review/export schema are queryable.",
    };
  } catch {
    return {
      pass: false,
      detail: "Creator database probe failed; verify the complete approved Creator migration has been applied.",
    };
  }
}

export async function verifyCreatorRuntimeAcceptance(
  deps: AcceptanceDeps = {},
): Promise<CreatorRuntimeAcceptance> {
  const configuration = deps.configuration ?? buildCreatorRuntimePreflight();
  const databaseProbe = deps.databaseProbe ?? probeCreatorDatabase;
  const storageProbe = deps.storageProbe ?? storageRoundTripProbe;

  const checks: CreatorPreflightCheck[] = [...configuration.checks];

  const databaseConfigured = configuration.checks.find(check => check.id === "DATABASE_CONFIGURED")?.pass;
  const storageConfigured = configuration.checks.find(check => check.id === "STORAGE_CONFIGURED")?.pass;

  const database = databaseConfigured
    ? await databaseProbe()
    : { pass: false, detail: "Database runtime probe skipped because DATABASE_URL is not configured." };
  checks.push({ id: "CREATOR_DATABASE_QUERYABLE", required: true, ...database });

  const storage = storageConfigured
    ? await storageProbe()
    : { pass: false, detail: "Storage round-trip skipped because storage is not configured." };
  checks.push({ id: "STORAGE_WRITE_READ_VERIFIED", required: true, ...storage });

  return {
    readyForPaidGeneration: checks.filter(check => check.required).every(check => check.pass),
    productionApproved: false,
    checks,
  };
}
