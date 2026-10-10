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
 * Stopwords (English, Tamil script, Tanglish). A query made ONLY of these carries no retrievable information: it is
 * suppressed (no lexical terms and no embedding lookup) instead of retrieving low-precision noise for the model.
 * Queries with at least one other token are unaffected: stopwords are never removed from them.
 */
const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "if", "of", "to", "in", "on", "at", "by", "for", "as", "is", "it", "be", "am", "are", "was", "were", "been", "do", "does", "did", "i", "me", "my", "we", "our", "you", "your", "he", "she", "they", "them", "his", "her", "its", "their", "this", "that", "these", "those", "there", "here", "what", "which", "who", "whom", "when", "where", "why", "how", "can", "could", "would", "should", "will", "shall", "may", "might", "not", "no", "with", "from", "into", "than", "then", "so", "tell", "give", "show", "please", "about", "any", "all", "have", "has", "had",
  "என்ன", "எது", "எந்த", "எப்படி", "எங்கே", "எங்கு", "யார்", "ஏன்", "எப்போது", "இது", "அது", "இந்த", "அந்த", "இங்கே", "அங்கே", "உள்ளது", "உள்ள", "உள்ளன", "மற்றும்", "ஒரு", "என்று", "என", "ஆக", "இல்லை", "உண்டு", "வேண்டும்", "பற்றி", "ஆம்", "இல்",
  "enna", "ethu", "edhu", "entha", "eppadi", "epdi", "enge", "engu", "yaar", "yar", "yen", "eppothu", "ithu", "idhu", "athu", "adhu", "intha", "antha", "inge", "ange", "irukku", "irukkum", "ullathu", "ulladhu", "mattrum", "matrum", "oru", "illai", "illa", "undu", "venum", "pathi", "patri",
]);
const stopKey = (token: string) => token.toLowerCase();

/** True when the query has tokens but every one is a stopword (e.g. "what is the", "என்ன அது"). */
export function isLowInformationQuery(query: string): boolean {
  const tokens = (normalizeRetrievalText(query).match(TOKEN_RUN) ?? []).map(t => t.replace(/^[-_]+|[-_]+$/g, "")).filter(t => HAS_LETTER_OR_NUMBER.test(t));
  return tokens.length > 0 && tokens.every(t => STOPWORDS.has(stopKey(t)));
}

/**
 * Deterministic Tamil <-> Tanglish phonetic skeleton (Package 0019). Both scripts are reduced to the same coarse
 * consonant key: vowels/length/aspiration/voicing are discarded (k=g, t=d=th=dh, p=b, s=ch=j=sh, l=zh=L, n=N=ng, r=R).
 * It is a heuristic for matching a Latin-script Tamil token against a Tamil-script token (or the reverse) ONLY:
 * it is never applied Latin-to-Latin (that would add English homophone noise) and it is NOT semantic search.
 * A key needs >= 2 consonants; a transliteration-only match counts half a lexical hit.
 */
const TAMIL_CONSONANT: Record<string, string> = { "க": "k", "ங": "n", "ச": "s", "ஞ": "n", "ட": "t", "ண": "n", "த": "t", "ந": "n", "ப": "p", "ம": "m", "ய": "y", "ர": "r", "ல": "l", "வ": "v", "ழ": "l", "ள": "l", "ற": "r", "ன": "n", "ஜ": "s", "ஷ": "s", "ஸ": "s", "ஹ": "" };
const LATIN_CONSONANT: Record<string, string> = { b: "p", c: "k", d: "t", f: "p", g: "k", h: "", j: "s", k: "k", l: "l", m: "m", n: "n", p: "p", q: "k", r: "r", s: "s", t: "t", v: "v", w: "v", x: "ks", y: "y", z: "s" };
const TAMIL_RANGE = /[\u0B80-\u0BFF]/u;
const LATIN_LETTER = /[a-z]/;
const LATIN_DIGRAPHS: Array<[string, string]> = [["zh", "l"], ["th", "t"], ["dh", "t"], ["sh", "s"], ["ch", "s"], ["ng", "nk"], ["kh", "k"], ["gh", "k"], ["bh", "p"], ["ph", "p"]];

export type TokenScript = "tamil" | "latin" | "other";
export function tokenScript(token: string): TokenScript {
  if (/^[\u0B80-\u0BFF\p{N}_-]+$/u.test(token) && TAMIL_RANGE.test(token)) return "tamil";
  if (/^[a-z0-9_-]+$/.test(token) && LATIN_LETTER.test(token)) return "latin";
  return "other";
}

const collapse = (key: string) => key.replace(/(.)\1+/g, "$1");
export function translitKey(token: string): string | null {
  const script = tokenScript(token);
  let key = "";
  if (script === "tamil") { for (const ch of token.split("ன்ற").join("\u0001")) key += ch === "\u0001" ? "ntr" : (TAMIL_CONSONANT[ch] ?? ""); } // ன்ற is pronounced ndr/ntr
  else if (script === "latin") {
    let t = token;
    for (const [from, to] of LATIN_DIGRAPHS) t = t.split(from).join(` ${to} `);
    for (const part of t.split(" ")) { if (part === "nk" || part === "l" || part === "t" || part === "s" || part === "k" || part === "p") { key += part; continue; } for (const ch of part) key += LATIN_CONSONANT[ch] ?? ""; }
  } else return null;
  key = collapse(key);
  return Array.from(key).length >= 2 ? key : null;
}

/** Index-side companion of searchText: marker + script-tagged keys, so SQL LIKE can find cross-script candidates. */
export const TRANSLIT_MARKER = "~tl~";
export function translitIndexBlock(normalizedContent: string): string {
  const keys = new Set<string>();
  for (const run of normalizedContent.match(TOKEN_RUN) ?? []) {
    const token = run.replace(/^[-_]+|[-_]+$/g, ""); const key = translitKey(token); const script = tokenScript(token);
    if (key && script !== "other") keys.add(`${script === "tamil" ? "t" : "l"}:${key}`);
  }
  return `${TRANSLIT_MARKER} ${[...keys].join(" ")} `;
}

/** Index tags a query term may match across scripts: a Latin term seeks Tamil-derived keys and vice versa. */
export function crossScriptTag(term: string): string | null {
  const key = translitKey(term); const script = tokenScript(term);
  if (!key || script === "other") return null;
  return `${script === "latin" ? "t" : "l"}:${key}`;
}

/**
 * Language-neutral lexical terms: Unicode letters/marks/numbers, deduplicated in order.
 * Punctuation-only and mark-only runs are never terms. Short-token noise filtering keeps
 * the previous ASCII rule (>= 3 characters); non-ASCII tokens need >= 2 code points so
 * two-character words in scripts such as Han are not discarded.
 */
export function normalizeRetrievalTerms(query: string): string[] {
  if (isLowInformationQuery(query)) return [];
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
  let crossKeys: Set<string> | null = null; // lazily built: only when a term has no direct hit
  const lexicalHits = input.terms.reduce((count, term) => {
    if (haystack.includes(term)) return count + 1;
    const tag = crossScriptTag(term);
    if (!tag) return count;
    crossKeys ??= new Set(translitIndexBlock(haystack).split(" ").slice(1));
    return count + (crossKeys.has(tag) ? 0.5 : 0);
  }, 0);
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
  if (isLowInformationQuery(query)) return [];
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
    // Deterministic: ties on score are broken by chunk id so the same data always ranks identically.
    .sort((a, b) => b.score - a.score || (a as { id?: number }).id! - (b as { id?: number }).id!)
    .slice(0, limit);
}
