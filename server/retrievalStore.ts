import { and, asc, desc, eq, isNotNull, isNull, notLike, or, sql, type SQL } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/mysql2";
import { documentChunks, documents } from "../drizzle/schema";
import { crossScriptTag, isLowInformationQuery, normalizeRetrievalTerms, normalizeRetrievalText, rankChunkCandidates, TRANSLIT_MARKER, translitIndexBlock } from "./retrieval";

/**
 * Tenant-safe, DB-first candidate selection for retrieval.
 *
 * Every query is scoped by workspace IN SQL (chunk AND document workspace) before any ranking; nothing
 * global is ever fetched and filtered afterwards. Three bounded candidate sources are merged and then ranked
 * by the unchanged deterministic scorer:
 *   1. lexical: chunks whose normalized searchText contains >= 1 query term, ordered in SQL by matched-term
 *      count (identical to the JS lexical score) then id; top LEXICAL_CANDIDATE_LIMIT.
 *   2. legacy: rows not yet backfilled (searchText IS NULL), ranked in JS; capped, shrinks to zero after backfill.
 *   3. semantic (only with a query vector): rows embedded by the SAME model, newest first, capped. This is a
 *      brute-force scan of a bounded window, not an ANN index.
 */
type Db = ReturnType<typeof drizzle>;
const envInt = (name: string, fallback: number, max: number) => {
  const parsed = Number(process.env[name]);
  return Number.isInteger(parsed) && parsed >= 1 ? Math.min(parsed, max) : fallback;
};
export const LEXICAL_CANDIDATE_LIMIT = () => envInt("RETRIEVAL_LEXICAL_CANDIDATES", 200, 2000);
export const LEGACY_CANDIDATE_LIMIT = () => envInt("RETRIEVAL_LEGACY_CANDIDATES", 500, 5000);
export const SEMANTIC_SCAN_LIMIT = () => envInt("RETRIEVAL_SEMANTIC_SCAN_LIMIT", 1000, 5000);
export const MAX_QUERY_TERMS = 24;

const LIKE_ESCAPE = "!";
/** Escapes LIKE wildcards so query text can never act as a pattern. */
export const likePattern = (term: string) => `%${term.replace(/[!%_]/g, match => `${LIKE_ESCAPE}${match}`)}%`;

const selection = { chunk: documentChunks, document: { filename: documents.filename, mimeType: documents.mimeType } };
const scopedTo = (workspaceId: number) => [eq(documentChunks.workspaceId, workspaceId), eq(documents.workspaceId, workspaceId)];

export type CandidateRow = { chunk: typeof documentChunks.$inferSelect; document: { filename: string; mimeType: string } };

export async function fetchRetrievalCandidates(
  db: Db,
  workspaceId: number,
  query: string,
  semantic: { model: string } | null,
): Promise<CandidateRow[]> {
  if (isLowInformationQuery(query)) return [];
  const terms = normalizeRetrievalTerms(query).slice(0, MAX_QUERY_TERMS);
  const byId = new Map<number, CandidateRow>();
  const add = (rows: CandidateRow[]) => { for (const row of rows) if (!byId.has(row.chunk.id)) byId.set(row.chunk.id, row); };

  if (terms.length) {
    const matches: SQL[] = terms.map(term => sql`(${documentChunks.searchText} COLLATE utf8mb4_bin LIKE ${likePattern(term)} ESCAPE '!')`);
    // Cross-script (Tamil <-> Tanglish) candidates: space-delimited script-tagged keys appended to searchText at index time.
    const tags = [...new Set(terms.map(crossScriptTag).filter((tag): tag is string => !!tag))].slice(0, MAX_QUERY_TERMS);
    for (const tag of tags) matches.push(sql`(${documentChunks.searchText} COLLATE utf8mb4_bin LIKE ${likePattern(` ${tag} `)} ESCAPE '!')`);
    const hits = sql.join(matches, sql` + `);
    add(
      await db.select(selection).from(documentChunks).innerJoin(documents, eq(documentChunks.documentId, documents.id))
        .where(and(...scopedTo(workspaceId), isNotNull(documentChunks.searchText), sql`(${hits}) > 0`))
        .orderBy(desc(hits), asc(documentChunks.id))
        .limit(LEXICAL_CANDIDATE_LIMIT()),
    );
  }

  add(
    await db.select(selection).from(documentChunks).innerJoin(documents, eq(documentChunks.documentId, documents.id))
      .where(and(...scopedTo(workspaceId), isNull(documentChunks.searchText)))
      .orderBy(asc(documentChunks.id))
      .limit(LEGACY_CANDIDATE_LIMIT()),
  );

  if (semantic) {
    add(
      await db.select(selection).from(documentChunks).innerJoin(documents, eq(documentChunks.documentId, documents.id))
        .where(and(...scopedTo(workspaceId), eq(documentChunks.embeddingModel, semantic.model), isNotNull(documentChunks.embeddingJson)))
        .orderBy(desc(documentChunks.id))
        .limit(SEMANTIC_SCAN_LIMIT()),
    );
  }
  return [...byId.values()];
}

export async function searchWorkspaceChunks(db: Db, workspaceId: number, query: string, semantic: { vector: number[]; model: string } | null, limit = 8) {
  const candidates = await fetchRetrievalCandidates(db, workspaceId, query, semantic ? { model: semantic.model } : null);
  // The scorer ignores searchText; drop it so it is never returned to callers.
  const rows = candidates.map(({ chunk, document }) => ({ chunk: { ...chunk, searchText: null }, document }));
  return rankChunkCandidates(rows, query, semantic?.vector ?? null, limit, semantic?.model ?? null);
}

/**
 * Idempotent maintenance: fills searchText for legacy rows (NULL) AND upgrades rows indexed before transliteration keys
 * existed (no TRANSLIT_MARKER) in id order. Returns how many rows were updated. Safe to re-run; a finished table updates 0.
 */
export async function backfillSearchText(db: Db, options: { batchSize?: number; maxBatches?: number } = {}): Promise<number> {
  const batchSize = Math.max(1, Math.min(options.batchSize ?? 500, 2000));
  const stale = or(isNull(documentChunks.searchText), notLike(documentChunks.searchText, `%${TRANSLIT_MARKER}%`));
  let updated = 0;
  for (let batch = 0; batch < (options.maxBatches ?? Number.POSITIVE_INFINITY); batch += 1) {
    const rows = await db.select({ id: documentChunks.id, content: documentChunks.content }).from(documentChunks).where(stale).orderBy(asc(documentChunks.id)).limit(batchSize);
    if (!rows.length) break;
    for (const row of rows) {
      await db.update(documentChunks).set({ searchText: searchTextFor(row.content) }).where(and(eq(documentChunks.id, row.id), stale));
      updated += 1;
    }
  }
  return updated;
}

export const searchTextFor = (content: string) => { const normalized = normalizeRetrievalText(content); return `${normalized}\n${translitIndexBlock(normalized)}`; };
