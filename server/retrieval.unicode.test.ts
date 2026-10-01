import { describe, expect, it } from "vitest";
import {
  normalizeRetrievalTerms,
  normalizeRetrievalText,
  rankChunkCandidates,
  scoreRetrievalCandidate,
} from "./retrieval";

const TAMIL_QUERY = "முருகன் கோவில் எங்கு உள்ளது?"; // "Where is the Murugan temple?"
const TAMIL_TERMS = ["முருகன்", "கோவில்", "எங்கு", "உள்ளது"];

describe("unicode-aware lexical terms", () => {
  it("keeps existing English behaviour", () => {
    expect(normalizeRetrievalTerms("  Murugan, AI + RAG! an of  ")).toEqual(["murugan", "rag"]);
    expect(normalizeRetrievalTerms("What is the temple timing?")).toEqual(["what", "the", "temple", "timing"]);
    expect(normalizeRetrievalTerms("rag-system under_score 2026")).toEqual(["rag-system", "under_score", "2026"]);
  });

  it("keeps meaningful Tamil terms whole (vowel signs and viramas are not word breaks)", () => {
    expect(normalizeRetrievalTerms(TAMIL_QUERY)).toEqual(TAMIL_TERMS);
    // No term may be a lone consonant fragment produced by splitting on combining marks.
    for (const term of normalizeRetrievalTerms(TAMIL_QUERY)) expect(Array.from(term).length).toBeGreaterThan(2);
  });

  it("handles mixed Tamil and English", () => {
    expect(normalizeRetrievalTerms("Murugan temple முருகன் கோவில் 2026")).toEqual([
      "murugan", "temple", "முருகன்", "கோவில்", "2026",
    ]);
  });

  it("treats punctuation as separators, including Tamil-adjacent and non-Latin punctuation", () => {
    const expected = ["முருகன்", "கோவில்", "எங்கு"];
    expect(normalizeRetrievalTerms("முருகன்,கோவில்;எங்கு?!")).toEqual(expected);
    expect(normalizeRetrievalTerms("“முருகன்” (கோவில்) … எங்கு।")).toEqual(expected);
    expect(normalizeRetrievalTerms("foo.bar don't")).toEqual(["foo", "bar", "don"]);
  });

  it("never turns whitespace or punctuation-only input into terms", () => {
    for (const input of ["", "   ", "\t\n\r", " 　 ", "?!.,;:", "--- ___ -_-", "… “ ” ، 。 ¿ ¡", "+ * / = < >"]) {
      expect(normalizeRetrievalTerms(input), JSON.stringify(input)).toEqual([]);
    }
  });

  it("never lets a lone combining mark or single character become a term", () => {
    expect(normalizeRetrievalTerms("ு ் ா க")).toEqual([]);
    expect(normalizeRetrievalTerms("்ு x")).toEqual([]);
  });

  it("deduplicates terms, including case and normalization variants", () => {
    expect(normalizeRetrievalTerms("கோவில் கோவில் KOVIL kovil Kovil")).toEqual(["கோவில்", "kovil"]);
    expect(normalizeRetrievalTerms("temple temple temple")).toEqual(["temple"]);
  });

  it("folds Unicode normalization equivalents", () => {
    const composed = "\u0b95\u0bca\u0b9f\u0bbf"; // KA + VOWEL SIGN O (U+0BCA) + TTA + VOWEL SIGN I
    const decomposed = "\u0b95\u0bc6\u0bbe\u0b9f\u0bbf"; // KA + VOWEL SIGN E (U+0BC6) + VOWEL SIGN AA (U+0BBE) + TTA + VOWEL SIGN I
    expect(composed).not.toBe(decomposed);
    expect(normalizeRetrievalTerms(composed)).toEqual(normalizeRetrievalTerms(decomposed));
    expect(normalizeRetrievalTerms("ﬁle ＦＩＬＥ")).toEqual(["file"]); // ligature + full-width forms
    expect(normalizeRetrievalTerms("cafe\u0301 caf\u00e9")).toEqual(["caf\u00e9"]); // combining acute vs precomposed
  });

  it("ignores invisible joiners so they cannot split or alter a word", () => {
    expect(normalizeRetrievalTerms("மு‌ருகன் mur​ugan")).toEqual(["முருகன்", "murugan"]);
  });

  it("folds decimal digits of any script to ASCII", () => {
    expect(normalizeRetrievalTerms("௨௦௨௬")).toEqual(["2026"]); // Tamil digits
    expect(normalizeRetrievalTerms("٢٠٢٦")).toEqual(["2026"]); // Arabic-Indic digits
    expect(normalizeRetrievalTerms("२०२६")).toEqual(["2026"]); // Devanagari digits
    expect(normalizeRetrievalTerms("２０２６")).toEqual(["2026"]); // full-width digits
    expect(normalizeRetrievalText("கோவில் ௨௦௨௬")).toBe("கோவில் 2026");
  });

  it("digit folding is correct for EVERY decimal-digit run the runtime knows", () => {
    // Property: each maximal run of \p{Nd} code points is a whole number of 0-9 blocks,
    // and folding maps the k-th digit of a block to k.
    let run: number[] = [];
    const flush = () => {
      if (!run.length) return;
      expect(run.length % 10, `run starting U+${run[0].toString(16)}`).toBe(0);
      run.forEach((cp, index) => {
        const expected = String(index % 10);
        const folded = normalizeRetrievalText(String.fromCodePoint(cp));
        // NFKC may already fold compatibility digits (e.g. full-width) to the same ASCII digit.
        expect(folded, `U+${cp.toString(16)}`).toBe(expected);
      });
      run = [];
    };
    for (let cp = 0x30; cp <= 0x1ffff; cp += 1) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      if (/\p{Nd}/u.test(String.fromCodePoint(cp))) run.push(cp);
      else flush();
    }
    flush();
  });

  it("is language-neutral (non-ASCII two-character words survive; other scripts tokenize)", () => {
    expect(normalizeRetrievalTerms("中国 东京")).toEqual(["中国", "东京"]);
    expect(normalizeRetrievalTerms("भारत की राजधानी")).toEqual(["भारत", "की", "राजधानी"]);
    expect(normalizeRetrievalTerms("Привет, мир! مرحبا")).toEqual(["привет", "мир", "مرحبا"]);
    expect(normalizeRetrievalTerms("தமிழ்நாடு தமிழ்-பாடு")).toEqual(["தமிழ்நாடு", "தமிழ்-நாடு"]);
  });
});

describe("lexical scoring with embeddings unavailable", () => {
  const relevant = "முருகன் கோவில் பழநியில் உள்ளது";
  const irrelevant = "பருவமழை காலத்தில் வயல்களில் நீர் நிறைந்தது";
  const score = (content: string, query = TAMIL_QUERY) =>
    scoreRetrievalCandidate({ content, terms: normalizeRetrievalTerms(query), queryVector: null, candidateVector: null });

  it("scores a relevant Tamil chunk above zero and labels it lexical", () => {
    const result = score(relevant);
    expect(result.retrievalMethod).toBe("lexical");
    expect(result.semanticScore).toBe(0);
    expect(result.lexicalScore).toBeCloseTo(3 / 4, 10); // முருகன், கோவில், உள்ளது (எங்கு absent)
    expect(result.score).toBeCloseTo(0.75, 10);
  });

  it("gives irrelevant Tamil content a zero score (no false positive)", () => {
    expect(score(irrelevant).score).toBe(0);
    expect(score("temple timings in English only").score).toBe(0);
  });

  it("matches across Unicode normalization differences between query and content", () => {
    const decomposedContent = "கொடி மரம் கோயிலில்".normalize("NFD");
    expect(score(decomposedContent, "கொடி").score).toBe(1);
    expect(score("திருவிழா 2026 ஆண்டு", "௨௦௨௬ திருவிழா").score).toBe(1);
  });

  it("scores English exactly as before, and punctuation-only queries match nothing", () => {
    expect(score("Murugan temple history", "murugan temple").score).toBe(1);
    expect(score("anything at all", "?!... ---").score).toBe(0);
    expect(score("anything at all", "").score).toBe(0);
  });
});

describe("rankChunkCandidates (the searchChunks scoring path)", () => {
  const doc = (filename: string) => ({ filename, mimeType: "text/plain" });
  const rows = [
    { chunk: { id: 1, content: "பருவமழை காலத்தில் வயல்களில் நீர் நிறைந்தது", embeddingJson: null }, document: doc("rain.txt") },
    { chunk: { id: 2, content: "முருகன் கோவில் பழநியில் உள்ளது; எங்கு செல்வது என்பதை வழிகாட்டி கூறும்.", embeddingJson: null }, document: doc("temples-ta.txt") },
    { chunk: { id: 3, content: "Murugan temple opening hours", embeddingJson: null }, document: doc("temples-en.txt") },
    { chunk: { id: 4, content: "முருகன் வழிபாடு Murugan worship 2026", embeddingJson: null }, document: doc("mixed.txt") },
  ];

  it("retrieves the relevant Tamil chunk first, with no embeddings, and excludes irrelevant ones", () => {
    const ranked = rankChunkCandidates(rows, TAMIL_QUERY, null);
    expect(ranked.map(r => r.id)).toEqual([2, 4]);
    expect(ranked[0]).toMatchObject({ filename: "temples-ta.txt", retrievalMethod: "lexical" });
    expect(ranked[0].score).toBe(1);
    expect(ranked.find(r => r.id === 1)).toBeUndefined();
  });

  it("retrieves mixed-language evidence from a mixed query", () => {
    const ranked = rankChunkCandidates(rows, "Murugan temple முருகன் கோவில்", null);
    expect(ranked.map(r => r.id)).toEqual([2, 3, 4].sort((a, b) => ranked.findIndex(r => r.id === a) - ranked.findIndex(r => r.id === b)));
    expect(new Set(ranked.map(r => r.id))).toEqual(new Set([2, 3, 4]));
    expect(ranked.every(r => r.score > 0 && r.score <= 1)).toBe(true);
  });

  it("returns nothing for punctuation-only or whitespace-only queries instead of matching everything", () => {
    expect(rankChunkCandidates(rows, "?!?! ---", null)).toEqual([]);
    expect(rankChunkCandidates(rows, "   ", null)).toEqual([]);
  });

  it("still fuses semantic vectors when they are available", () => {
    const withVectors = [{ chunk: { id: 9, content: "unrelated words", embeddingJson: "[1,0]" }, document: doc("v.txt") }];
    const ranked = rankChunkCandidates(withVectors, TAMIL_QUERY, [1, 0]);
    expect(ranked).toHaveLength(1);
    expect(ranked[0].retrievalMethod).toBe("semantic");
    expect(ranked[0].score).toBeCloseTo(0.65, 8);
  });

  it("caps the result count", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ chunk: { id: i, content: "murugan temple", embeddingJson: null }, document: doc(`f${i}.txt`) }));
    expect(rankChunkCandidates(many, "murugan temple", null)).toHaveLength(8);
    expect(rankChunkCandidates(many, "murugan temple", null, 3)).toHaveLength(3);
  });
});
