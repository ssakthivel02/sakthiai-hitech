import { createHash } from "node:crypto";
import { validateCreatorCaptionText } from "./captionIntegrity";
import { parseWavDurationMs } from "./wavMasterValidation";
export { parseWavDurationMs } from "./wavMasterValidation";
import { and, eq } from "drizzle-orm";
import {
  creatorAssets,
  creatorCaptionCues,
  creatorProjects,
  creatorTimelines,
} from "../../drizzle/schema";
import { getDb } from "../db";
import { storagePut } from "../storage";

export type CaptionCueInput = {
  startMs: number;
  endMs: number;
  text: string;
  language?: "ta" | "en";
};

export function validateCaptionCues(cues: CaptionCueInput[], durationMs: number): CaptionCueInput[] {
  if (!Number.isInteger(durationMs) || durationMs <= 0) throw new Error("CREATOR_AUDIO_DURATION_INVALID");
  const normalized = cues.map((cue) => ({
    startMs: cue.startMs,
    endMs: cue.endMs,
    text: validateCreatorCaptionText(cue.text),
    language: cue.language ?? "ta",
  }));

  let previousEnd = 0;
  for (const cue of normalized) {
    if (!Number.isInteger(cue.startMs) || !Number.isInteger(cue.endMs) || cue.startMs < 0 || cue.endMs <= cue.startMs) {
      throw new Error("CREATOR_CAPTION_RANGE_INVALID");
    }
    if (cue.endMs > durationMs) throw new Error("CREATOR_CAPTION_OUTSIDE_AUDIO_MASTER");
    if (cue.startMs < previousEnd) throw new Error("CREATOR_CAPTION_OVERLAP");
    previousEnd = cue.endMs;
  }
  return normalized;
}

async function requireDb() {
  const db = await getDb();
  if (!db) throw new Error("CREATOR_DATABASE_UNAVAILABLE");
  return db;
}

function readDurationFromProvenance(provenanceJson: string): number {
  try {
    const value = JSON.parse(provenanceJson) as { durationMs?: unknown };
    if (Number.isInteger(value.durationMs) && Number(value.durationMs) > 0) return Number(value.durationMs);
  } catch {
    // Fall through to a bounded Creator error rather than trusting malformed provenance.
  }
  throw new Error("CREATOR_AUDIO_DURATION_PROVENANCE_INVALID");
}

export async function ingestApprovedAudioMaster(input: {
  workspaceId: number;
  creatorProjectId: number;
  filename: string;
  mimeType: "audio/wav" | "audio/x-wav";
  data: Buffer;
  approvedByUserId: number;
}) {
  if (!input.data.length) throw new Error("CREATOR_AUDIO_EMPTY");
  if (input.data.byteLength > 250 * 1024 * 1024) throw new Error("CREATOR_AUDIO_TOO_LARGE");

  const durationMs = parseWavDurationMs(input.data);
  const checksumSha256 = createHash("sha256").update(input.data).digest("hex");
  const db = await requireDb();

  // Cheap preflight prevents unnecessary object writes. These checks are NOT
  // authoritative: another request may lock the master before we upload.
  const [project] = await db
    .select({ id: creatorProjects.id, audioMasterAssetId: creatorProjects.audioMasterAssetId })
    .from(creatorProjects)
    .where(and(eq(creatorProjects.id, input.creatorProjectId), eq(creatorProjects.workspaceId, input.workspaceId)))
    .limit(1);
  if (!project) throw new Error("CREATOR_PROJECT_NOT_FOUND");
  if (project.audioMasterAssetId) throw new Error("CREATOR_AUDIO_MASTER_ALREADY_LOCKED");

  const [duplicate] = await db
    .select({ id: creatorAssets.id })
    .from(creatorAssets)
    .where(and(eq(creatorAssets.workspaceId, input.workspaceId), eq(creatorAssets.checksumSha256, checksumSha256)))
    .limit(1);
  if (duplicate) throw new Error("CREATOR_AUDIO_DUPLICATE");

  const safeFilename = input.filename.normalize("NFKC").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 180) || "audio-master.wav";
  const stored = await storagePut(
    `creator/${input.workspaceId}/${input.creatorProjectId}/audio-master/${safeFilename}`,
    input.data,
    input.mimeType,
  );

  const provenance = {
    source: "human-approved-upload",
    approvedByUserId: input.approvedByUserId,
    checksumSha256,
    durationMs,
    immutableMaster: true,
    ingestedAt: new Date().toISOString(),
  };

  // All three database writes are atomic. The project row lock serializes
  // concurrent master uploads and the checks MUST be repeated under that lock.
  // A failed insert/update rolls back both the asset and the master pointer;
  // no half-created timeline may be exposed to the renderer.
  //
  // Do not delete the uploaded object on an ambiguous commit/network failure:
  // the transaction may have committed even if the client lost its response.
  // Keeping an unreferenced object is safer than deleting a committed master.
  // Orphans can be reconciled by storageKey after database recovery.
  return db.transaction(async (tx) => {
    const [lockedProject] = await tx
      .select({ id: creatorProjects.id, audioMasterAssetId: creatorProjects.audioMasterAssetId })
      .from(creatorProjects)
      .where(and(eq(creatorProjects.id, input.creatorProjectId), eq(creatorProjects.workspaceId, input.workspaceId)))
      .limit(1)
      .for("update");
    if (!lockedProject) throw new Error("CREATOR_PROJECT_NOT_FOUND");
    if (lockedProject.audioMasterAssetId) throw new Error("CREATOR_AUDIO_MASTER_ALREADY_LOCKED");

    const [lockedDuplicate] = await tx
      .select({ id: creatorAssets.id })
      .from(creatorAssets)
      .where(and(eq(creatorAssets.workspaceId, input.workspaceId), eq(creatorAssets.checksumSha256, checksumSha256)))
      .limit(1);
    if (lockedDuplicate) throw new Error("CREATOR_AUDIO_DUPLICATE");

    const result = await tx.insert(creatorAssets).values({
      workspaceId: input.workspaceId,
      creatorProjectId: input.creatorProjectId,
      assetType: "AUDIO_MASTER",
      mimeType: input.mimeType,
      storageKey: stored.key,
      checksumSha256,
      byteSize: input.data.byteLength,
      immutable: 1,
      provenanceJson: JSON.stringify(provenance),
      reviewDecision: "APPROVED",
    });
    const assetId = Number(result[0].insertId);
    if (!assetId) throw new Error("CREATOR_AUDIO_ASSET_CREATE_FAILED");

    await tx
      .update(creatorProjects)
      .set({ audioMasterAssetId: assetId })
      .where(and(eq(creatorProjects.id, input.creatorProjectId), eq(creatorProjects.workspaceId, input.workspaceId)));

    const timelineResult = await tx.insert(creatorTimelines).values({
      workspaceId: input.workspaceId,
      creatorProjectId: input.creatorProjectId,
      name: "Master 16:9",
      audioMasterAssetId: assetId,
      width: 1920,
      height: 1080,
      fps: 24,
    });
    const timelineId = Number(timelineResult[0].insertId);
    if (!timelineId) throw new Error("CREATOR_TIMELINE_CREATE_FAILED");

    return { assetId, timelineId, durationMs, checksumSha256, storageKey: stored.key, immutable: true as const };
  });
}

/**
 * A caption replacement is one unit of work: validate against the locked master,
 * delete the old rows and insert the new rows in the SAME MySQL transaction.
 * Locking the timeline row serializes concurrent replacements for one timeline.
 * Any insert failure rolls back the delete, preserving the last approved cues.
 */
export async function replaceLockedCaptionCues(input: {
  workspaceId: number;
  creatorProjectId: number;
  timelineId: number;
  cues: CaptionCueInput[];
}) {
  const db = await requireDb();
  return db.transaction(async (tx) => {
    const [timeline] = await tx
      .select({ id: creatorTimelines.id, audioMasterAssetId: creatorTimelines.audioMasterAssetId })
      .from(creatorTimelines)
      .where(
        and(
          eq(creatorTimelines.id, input.timelineId),
          eq(creatorTimelines.workspaceId, input.workspaceId),
          eq(creatorTimelines.creatorProjectId, input.creatorProjectId),
        ),
      )
      .limit(1)
      .for("update");
    if (!timeline) throw new Error("CREATOR_TIMELINE_NOT_FOUND");
    if (!timeline.audioMasterAssetId) throw new Error("CREATOR_TIMELINE_AUDIO_MASTER_MISSING");

    const [audioMaster] = await tx
      .select({ id: creatorAssets.id, assetType: creatorAssets.assetType, immutable: creatorAssets.immutable, provenanceJson: creatorAssets.provenanceJson })
      .from(creatorAssets)
      .where(
        and(
          eq(creatorAssets.id, timeline.audioMasterAssetId),
          eq(creatorAssets.workspaceId, input.workspaceId),
          eq(creatorAssets.creatorProjectId, input.creatorProjectId),
        ),
      )
      .limit(1);
    if (!audioMaster || audioMaster.assetType !== "AUDIO_MASTER" || audioMaster.immutable !== 1) {
      throw new Error("CREATOR_TIMELINE_AUDIO_MASTER_INVALID");
    }

    const audioDurationMs = readDurationFromProvenance(audioMaster.provenanceJson);
    const cues = validateCaptionCues(input.cues, audioDurationMs);

    await tx
      .delete(creatorCaptionCues)
      .where(
        and(
          eq(creatorCaptionCues.workspaceId, input.workspaceId),
          eq(creatorCaptionCues.creatorProjectId, input.creatorProjectId),
          eq(creatorCaptionCues.timelineId, input.timelineId),
        ),
      );

    if (cues.length) {
      await tx.insert(creatorCaptionCues).values(
        cues.map((cue) => ({
          workspaceId: input.workspaceId,
          creatorProjectId: input.creatorProjectId,
          timelineId: input.timelineId,
          language: cue.language ?? "ta",
          startMs: cue.startMs,
          endMs: cue.endMs,
          text: cue.text,
          locked: 1,
        })),
      );
    }

    return { timelineId: input.timelineId, audioMasterAssetId: audioMaster.id, audioDurationMs, cueCount: cues.length, locked: true as const };
  });
}
