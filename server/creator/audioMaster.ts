import { createHash } from "node:crypto";
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

export function parseWavDurationMs(buffer: Buffer): number {
  if (buffer.length < 44 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("CREATOR_AUDIO_INVALID_WAV");
  }

  let offset = 12;
  let byteRate: number | null = null;
  let dataBytes: number | null = null;

  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (body + size > buffer.length) throw new Error("CREATOR_AUDIO_TRUNCATED_WAV");

    if (id === "fmt ") {
      if (size < 16) throw new Error("CREATOR_AUDIO_INVALID_WAV_FMT");
      byteRate = buffer.readUInt32LE(body + 8);
      if (!byteRate) throw new Error("CREATOR_AUDIO_INVALID_BYTE_RATE");
    } else if (id === "data") {
      dataBytes = size;
    }

    offset = body + size + (size % 2);
  }

  if (!byteRate || dataBytes === null) throw new Error("CREATOR_AUDIO_WAV_CHUNKS_MISSING");
  return Math.max(1, Math.round((dataBytes / byteRate) * 1000));
}

export function validateCaptionCues(cues: CaptionCueInput[], durationMs: number): CaptionCueInput[] {
  if (!Number.isInteger(durationMs) || durationMs <= 0) throw new Error("CREATOR_AUDIO_DURATION_INVALID");
  const normalized = cues.map((cue) => ({
    startMs: cue.startMs,
    endMs: cue.endMs,
    text: cue.text.trim(),
    language: cue.language ?? "ta",
  }));

  let previousEnd = 0;
  for (const cue of normalized) {
    if (!Number.isInteger(cue.startMs) || !Number.isInteger(cue.endMs) || cue.startMs < 0 || cue.endMs <= cue.startMs) {
      throw new Error("CREATOR_CAPTION_RANGE_INVALID");
    }
    if (cue.endMs > durationMs) throw new Error("CREATOR_CAPTION_OUTSIDE_AUDIO_MASTER");
    if (cue.startMs < previousEnd) throw new Error("CREATOR_CAPTION_OVERLAP");
    if (!cue.text) throw new Error("CREATOR_CAPTION_TEXT_REQUIRED");
    if (cue.text.length > 600) throw new Error("CREATOR_CAPTION_TEXT_TOO_LONG");
    previousEnd = cue.endMs;
  }
  return normalized;
}

async function requireDb() {
  const db = await getDb();
  if (!db) throw new Error("CREATOR_DATABASE_UNAVAILABLE");
  return db;
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

  const result = await db.insert(creatorAssets).values({
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

  await db
    .update(creatorProjects)
    .set({ audioMasterAssetId: assetId })
    .where(and(eq(creatorProjects.id, input.creatorProjectId), eq(creatorProjects.workspaceId, input.workspaceId)));

  const timelineResult = await db.insert(creatorTimelines).values({
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
}

export async function replaceLockedCaptionCues(input: {
  workspaceId: number;
  creatorProjectId: number;
  timelineId: number;
  audioDurationMs: number;
  cues: CaptionCueInput[];
}) {
  const cues = validateCaptionCues(input.cues, input.audioDurationMs);
  const db = await requireDb();
  const [timeline] = await db
    .select({ id: creatorTimelines.id })
    .from(creatorTimelines)
    .where(
      and(
        eq(creatorTimelines.id, input.timelineId),
        eq(creatorTimelines.workspaceId, input.workspaceId),
        eq(creatorTimelines.creatorProjectId, input.creatorProjectId),
      ),
    )
    .limit(1);
  if (!timeline) throw new Error("CREATOR_TIMELINE_NOT_FOUND");

  await db
    .delete(creatorCaptionCues)
    .where(
      and(
        eq(creatorCaptionCues.workspaceId, input.workspaceId),
        eq(creatorCaptionCues.creatorProjectId, input.creatorProjectId),
        eq(creatorCaptionCues.timelineId, input.timelineId),
      ),
    );

  if (cues.length) {
    await db.insert(creatorCaptionCues).values(
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

  return { timelineId: input.timelineId, cueCount: cues.length, locked: true as const };
}
