import { cosineSimilarity, parseEmbedding } from "./embeddings";

export type RetrievalMethod = "lexical" | "semantic" | "hybrid";

/** Zero-width space/non-joiner/joiner, word joiner and BOM: invisible, must not split or alter words. */
const INVISIBLE_CHARACTERS = /[​-‍⁠﻿]/gu;
/**
 * A token is a run of letters, combining marks, numbers, "_" and "-".
 * Combining marks (\p{M}) are essential: Indic vowel signs and viramas
 * (e.g. Tamil "ு", "ி", "்") are marks, so a letters-only pattern would shred
 * every Tamil word into isolated consonants.
 */
const TOKEN_RUN = /[\p{L}\p{M}\p{N}_-]+/gu;
const HAS_LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;
const DECIMAL_DIGIT = /\p{Nd}/u;
const NON_ASCII = /[^\u0000-\u007F]/u;

/** ASCII digit value of a decimal digit from any script (Nd runs are contiguous 0-9 blocks). */
function decimalDigitValue(codePoint: number): number {
  let run = 0;
  // Adjacent 0-9 blocks exist (e.g. U+116D0-U+116E3), so count the whole contiguous Nd run, not just 10.
  while (codePoint - run - 1 >= 0x30 && DECIMAL_DIGIT.test(String.fromCodePoint(codePoint - run - 1))) run += 1;
  return run % 10;
}

function foldDecimalDigits(text: string): string {
  let out = "";
  for (const character of text) {
    const codePoint = character.codePointAt(0)!;
    out += codePoint > 0x7f && DECIMAL_DIGIT.test(character) ? String(decimalDigitValue(codePoint)) : character;
  }
  return out;
}

/**
 * Canonical form used on BOTH sides of lexical matching (query and content):
 * NFKC (composes Indic vowel signs, folds full-width/compatibility forms), invisible
 * format characters removed, locale-independent lowercase, and decimal digits of any
 * script folded to ASCII digits.
 */
export function normalizeRetrievalText(text: string): string {
  return foldDecimalDigits(text.normalize("NFKC").replace(INVISIBLE_CHARACTERS, "").toLowerCase());
}

/**
 * Language-neutral lexical terms: Unicode letters/marks/numbers, deduplicated in order.
 * Punctuation-only and mark-only runs are never terms. Short-token noise filtering keeps
 * the previous ASCII rule (>= 3 characters); non-ASCII tokens need >= 2 code points so
 * two-character words in scripts such as Han are not discarded.
 */
export function normalizeRetrievalTerms(query: string): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const run of normalizeRetrievalText(query).match(TOKEN_RUN) ?? []) {
    const token = run.replace(/^[-_]+|[-_]+$/g, "");
    if (!HAS_LETTER_OR_NUMBER.test(token)) continue;
    const minimumLength = NON_ASCII.test(token) ? 2 : 3;
    if (Array.from(token).length < minimumLength) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    terms.push(token);
  }
  return terms;
}

export function scoreRetrievalCandidate(input: {
  content: string;
  terms: string[];
  queryVector: number[] | null;
  candidateVector: number[] | null;
  /** When the query embedder's model is known, only vectors produced by the SAME model are comparable. */
  queryModel?: string | null;
  candidateModel?: string | null;
}): { score: number; retrievalMethod: RetrievalMethod; lexicalScore: number; semanticScore: number } {
  const haystack = input.terms.length ? normalizeRetrievalText(input.content) : "";
  const lexicalHits = input.terms.reduce(
    (count, term) => count + (haystack.includes(term) ? 1 : 0),
    0,
  );
  const lexicalScore = input.terms.length ? lexicalHits / input.terms.length : 0;
  const modelsComparable = !input.queryModel || input.candidateModel === input.queryModel;
  const hasSemantic = Boolean(
    modelsComparable &&
      input.queryVector &&
      input.candidateVector &&
      input.queryVector.length > 0 &&
      input.queryVector.length === input.candidateVector.length,
  );
  const semanticScore = hasSemantic
    ? Math.max(0, cosineSimilarity(input.queryVector!, input.candidateVector!))
    : 0;
  const score = hasSemantic ? lexicalScore * 0.35 + semanticScore * 0.65 : lexicalScore;
  const retrievalMethod: RetrievalMethod = hasSemantic
    ? lexicalHits > 0
      ? "hybrid"
      : "semantic"
    : "lexical";

  return { score, retrievalMethod, lexicalScore, semanticScore };
}

/**
 * Scores and ranks already tenant-filtered candidate rows. This is the exact
 * scoring path used by db.searchChunks, extracted so it is executable without a database.
 */
export function rankChunkCandidates<
  Chunk extends { content: string; embeddingJson: string | null; embeddingModel?: string | null },
  Doc extends { filename: string; mimeType: string },
>(
  rows: Array<{ chunk: Chunk; document: Doc }>,
  query: string,
  queryVector: number[] | null,
  limit = 8,
  queryModel: string | null = null,
) {
  const terms = normalizeRetrievalTerms(query);
  return rows
    .map(({ chunk, document }) => {
      const scored = scoreRetrievalCandidate({
        content: chunk.content,
        terms,
        queryVector,
        candidateVector: queryVector ? parseEmbedding(chunk.embeddingJson) : null,
        queryModel,
        candidateModel: chunk.embeddingModel ?? null,
      });
      return {
        ...chunk,
        filename: document.filename,
        mimeType: document.mimeType,
        score: scored.score,
        retrievalMethod: scored.retrievalMethod,
      };
    })
    .filter(row => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
