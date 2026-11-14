import type { RetrievalMethod } from "../retrieval";
import { excerptText } from "./store";

/**
 * Workspace search returns TWO separately ranked groups (artifacts, files), never one merged list: artifact hits are
 * lexical-only while file hits may be hybrid/semantic, so their scores are not comparable and are not pretended to be.
 */
export type ChunkHit = { documentId: number; filename: string; mimeType: string; page: number | null; section: string | null; content: string; score: number; retrievalMethod: RetrievalMethod };
export type DocumentHit = { documentId: number; filename: string; mimeType: string; page: number | null; section: string | null; score: number; retrievalMethod: RetrievalMethod; snippet: string };

/** Collapses chunk-level retrieval hits (already ranked best-first) to one hit per document, keeping its best chunk. */
export function groupDocumentHits(hits: ChunkHit[], limit = 10): DocumentHit[] {
  const seen = new Set<number>();
  const out: DocumentHit[] = [];
  for (const hit of hits) {
    if (seen.has(hit.documentId)) continue;
    seen.add(hit.documentId);
    out.push({ documentId: hit.documentId, filename: hit.filename, mimeType: hit.mimeType, page: hit.page, section: hit.section, score: Number(hit.score.toFixed(6)), retrievalMethod: hit.retrievalMethod, snippet: excerptText(hit.content.replace(/\s+/g, " ").trim(), 240) });
    if (out.length >= limit) break;
  }
  return out;
}
