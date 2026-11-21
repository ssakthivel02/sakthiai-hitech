import { and, eq } from "drizzle-orm";
import { documentChunks, documents, getDb, projects } from "../db";
import { serializeEmbedding, tryEmbed } from "../embeddings";
import { searchTextFor } from "../retrievalStore";
import { storagePut } from "../storage";
import { IngestError, type CommitInput, type Committer } from "./service";

export type CommitDeps = { put?: typeof storagePut; embed?: typeof tryEmbed };

/** Normal storage path: object storage + documents + chunks (+ embeddings when available). Reached ONLY after a CLEAN scan and successful extraction. */
export const createCommitter = (deps: CommitDeps = {}): Committer => async (input: CommitInput) => {
  const put = deps.put ?? storagePut; const embed = deps.embed ?? tryEmbed;
  const db = await getDb(); if (!db) throw new Error("database unavailable");
  const dup = await db.select({ id: documents.id }).from(documents).where(and(eq(documents.workspaceId, input.workspaceId), eq(documents.contentHash, input.contentHash))).limit(1);
  if (dup[0]) throw new IngestError("DUPLICATE", "Duplicate document already exists");
  const stored = await put(`${input.userId}/${input.workspaceId}/${input.filename}`, input.buffer, input.mimeType);
  await db.insert(documents).values({ workspaceId: input.workspaceId, projectId: input.projectId, filename: input.filename, mimeType: input.mimeType, storageKey: stored.key, extractedText: input.extracted.text, contentHash: input.contentHash, pageCount: input.extracted.pageCount });
  try {
  const created = await db.select().from(documents).where(and(eq(documents.workspaceId, input.workspaceId), eq(documents.contentHash, input.contentHash))).limit(1);
  const document = created[0]; if (!document) throw new Error("Document persistence failed");
  const chunks = [];
  for (let index = 0; index < input.extracted.segments.length; index += 1) {
    const segment = input.extracted.segments[index]; const embedded = await embed(segment.content);
    chunks.push({ ...segment, searchText: searchTextFor(segment.content), chunkIndex: index, documentId: document.id, workspaceId: input.workspaceId, embeddingJson: embedded ? serializeEmbedding(embedded.vector) : null, embeddingModel: embedded?.adapter.model ?? null });
  }
  if (chunks.length) await db.insert(documentChunks).values(chunks);
  return { documentId: document.id };
  } catch (error) {
    // Roll back a half-written document so a retry is not rejected as a duplicate and retrieval never sees a partial one.
    const half = await db.select({ id: documents.id }).from(documents).where(and(eq(documents.workspaceId, input.workspaceId), eq(documents.contentHash, input.contentHash))).limit(1).catch(() => []);
    if (half[0]) { await db.delete(documentChunks).where(eq(documentChunks.documentId, half[0].id)).catch(() => undefined); await db.delete(documents).where(eq(documents.id, half[0].id)).catch(() => undefined); }
    throw error;
  }
};

export async function projectBelongsToWorkspace(workspaceId: number, projectId: number): Promise<boolean> {
  const db = await getDb(); if (!db) return false;
  const rows = await db.select({ id: projects.id }).from(projects).where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId))).limit(1);
  return Boolean(rows[0]);
}
