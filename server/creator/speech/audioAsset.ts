import { and, eq } from "drizzle-orm";
import { creatorAssets } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { storageRead } from "../../storage";
import { parseWav } from "./wav";

export type AudioAssetRow = {
  id: number; workspaceId: number; creatorProjectId: number; assetType: string; mimeType: string;
  storageKey: string; immutable: number; reviewDecision: string; byteSize: number | null;
};

const MAX_AVATAR_AUDIO_BYTES = 50 * 1024 * 1024;

/**
 * Only an approved, immutable WAV audio asset of this workspace + project may drive an avatar: the locked audio master,
 * or generated speech after a human HUMAN_SPEECH PASS (reviewSpeech). It is never auto-approved here.
 */
export function validateAvatarAudioAsset(row: AudioAssetRow | undefined, input: { workspaceId: number; creatorProjectId: number }): AudioAssetRow {
  if (!row) throw new Error("CREATOR_AVATAR_AUDIO_NOT_FOUND");
  if (row.workspaceId !== input.workspaceId || row.creatorProjectId !== input.creatorProjectId) throw new Error("CREATOR_AVATAR_AUDIO_SCOPE_MISMATCH");
  if (row.assetType !== "AUDIO" && row.assetType !== "AUDIO_MASTER") throw new Error("CREATOR_AVATAR_AUDIO_NOT_AUDIO");
  if (row.mimeType !== "audio/wav" && row.mimeType !== "audio/x-wav") throw new Error("CREATOR_AVATAR_AUDIO_MIME_UNSUPPORTED");
  if (row.immutable !== 1) throw new Error("CREATOR_AVATAR_AUDIO_MUTABLE");
  if (row.reviewDecision !== "APPROVED") throw new Error("CREATOR_AVATAR_AUDIO_NOT_APPROVED");
  if (row.byteSize !== null && row.byteSize > MAX_AVATAR_AUDIO_BYTES) throw new Error("CREATOR_AVATAR_AUDIO_TOO_LARGE");
  return row;
}

export async function resolveAvatarAudio(input: { workspaceId: number; creatorProjectId: number; assetId: number }, read: (key: string) => Promise<Uint8Array> = storageRead) {
  const db = await getDb();
  if (!db) throw new Error("CREATOR_DATABASE_UNAVAILABLE");
  const [row] = await db.select({
    id: creatorAssets.id, workspaceId: creatorAssets.workspaceId, creatorProjectId: creatorAssets.creatorProjectId,
    assetType: creatorAssets.assetType, mimeType: creatorAssets.mimeType, storageKey: creatorAssets.storageKey,
    immutable: creatorAssets.immutable, reviewDecision: creatorAssets.reviewDecision, byteSize: creatorAssets.byteSize,
  }).from(creatorAssets)
    .where(and(eq(creatorAssets.id, input.assetId), eq(creatorAssets.workspaceId, input.workspaceId), eq(creatorAssets.creatorProjectId, input.creatorProjectId)))
    .limit(1);
  const asset = validateAvatarAudioAsset(row, input);
  const data = await read(asset.storageKey);
  if (data.byteLength > MAX_AVATAR_AUDIO_BYTES) throw new Error("CREATOR_AVATAR_AUDIO_TOO_LARGE");
  let durationMs: number;
  try { durationMs = parseWav(Buffer.from(data)).durationMs; } catch { throw new Error("CREATOR_AVATAR_AUDIO_INVALID_WAV"); }
  return { assetId: asset.id, data, mimeType: "audio/wav" as const, durationMs };
}
