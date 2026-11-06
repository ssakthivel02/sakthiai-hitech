import { describe, expect, it } from "vitest";
import { crossScriptTag, isLowInformationQuery, normalizeRetrievalTerms, rankChunkCandidates, scoreRetrievalCandidate, tokenScript, translitIndexBlock, translitKey } from "./retrieval";

const score = (content: string, query: string) => scoreRetrievalCandidate({ content, terms: normalizeRetrievalTerms(query), queryVector: null, candidateVector: null });
const row = (id: number, content: string) => ({ chunk: { id, content, embeddingJson: null }, document: { filename: `${id}.txt`, mimeType: "text/plain" } });

describe("Tamil <-> Tanglish phonetic skeleton", () => {
  it("maps both scripts to the same key for common words", () => {
    const pairs: Array<[string, string]> = [["kovil", "கோவில்"], ["kaalai", "காலை"], ["thirakkum", "திறக்கும்"], ["murugan", "முருகன்"], ["engu", "எங்கு"], ["malai", "மலை"], ["tamizh", "தமிழ்"], ["palani", "பழநி"], ["nandri", "நன்றி"], ["manikku", "மணிக்கு"]];
    for (const [latin, tamil] of pairs) expect([latin, translitKey(latin)]).toEqual([latin, translitKey(tamil)]);
    expect(translitKey("kovil")).toBe("kvl"); expect(translitKey("thirakkum")).toBe("trkm");
  });
  it("needs >= 2 consonants and ignores mixed-script, digit-only and non-Tamil/Latin tokens", () => {
    expect(translitKey("a")).toBeNull(); expect(translitKey("அது")).toBeNull(); expect(translitKey("2026")).toBeNull();
    expect(translitKey("முருகன்murugan")).toBeNull(); expect(translitKey("привет")).toBeNull(); expect(translitKey("भारत")).toBeNull();
    expect(tokenScript("murugan")).toBe("latin"); expect(tokenScript("முருகன்")).toBe("tamil"); expect(tokenScript("முருகன்x")).toBe("other");
  });
  it("only crosses scripts: a Latin term seeks Tamil-derived keys and vice versa", () => {
    expect(crossScriptTag("kovil")).toBe("t:kvl"); expect(crossScriptTag("கோவில்")).toBe("l:kvl"); expect(crossScriptTag("a")).toBeNull();
  });
  it("Tanglish query finds a Tamil-script chunk, and Tamil query finds a Tanglish chunk, at half weight", () => {
    const ta = score("முருகன் கோவில் பழநியில் உள்ளது. கோவில் காலை ஆறு மணிக்குத் திறக்கப்படும்.", "kovil kaalai thirakkum");
    expect(ta.score).toBeGreaterThan(0); expect(ta.retrievalMethod).toBe("lexical");
    expect(ta.lexicalScore).toBeCloseTo((0.5 + 0.5) / 3, 10); // kovil, kaalai via key; thirakkum != thirakkappadum
    const en = score("palani murugan kovil kaalai aaru manikku thirakkum. kovil malai mel ulladhu.", "மலை மேல் கோவில் எங்கே");
    expect(en.lexicalScore).toBeCloseTo((0.5 + 0.5 + 0.5) / 4, 10);
    expect(score("kovil", "கோவில்").score).toBe(0.5);
    expect(score("கோவில்", "கோவில்").score).toBe(1); // a direct hit always outranks a transliteration hit
  });
  it("never matches Latin to Latin (no English homophone noise) nor unrelated words", () => {
    expect(score("we love policy", "leave policy").lexicalScore).toBeCloseTo(0.5, 10); // only the direct 'policy' hit
    expect(score("the mile marker", "malai").score).toBe(0);
    expect(score("temple timings in English only", "முருகன் கோவில்").score).toBe(0);
    expect(score("பருவமழை காலத்தில் வயல்களில்", "kovil").score).toBe(0);
  });
  it("index block carries a marker and script-tagged keys only for tokens with a key", () => {
    const block = translitIndexBlock("murugan கோவில் a 2026");
    expect(block.startsWith("~tl~ ")).toBe(true); expect(block).toContain(" l:mrkn "); expect(block).toContain(" t:kvl ");
    expect(block).not.toMatch(/2026|:a /);
  });
});

describe("stopword-only / low-information queries are suppressed", () => {
  const rows = [row(1, "what is the capital of the temple and the town"), row(2, "அது என்ன இது"), row(3, "enna athu"), row(4, "leave policy is 25 days")];
  it("English, Tamil and Tanglish stopword-only queries retrieve nothing and yield no terms", () => {
    for (const q of ["what is the", "The", "is it", "என்ன அது", "எது இது?", "enna athu", "Tell me about"]) {
      expect([q, isLowInformationQuery(q)]).toEqual([q, true]); expect(normalizeRetrievalTerms(q)).toEqual([]);
      expect(rankChunkCandidates(rows, q, null)).toEqual([]);
      expect(rankChunkCandidates(rows, q, [1, 0, 0])).toEqual([]); // not even via embeddings
    }
  });
  it("any informative token keeps the query fully functional and stopwords are not removed from it", () => {
    for (const q of ["what is the leave policy", "leave", "என்ன கோவில்", "enna kovil"]) expect([q, isLowInformationQuery(q)]).toEqual([q, false]);
    expect(normalizeRetrievalTerms("what is the leave policy")).toEqual(["what", "the", "leave", "policy"]);
    const ranked = rankChunkCandidates(rows, "what is the leave policy", null);
    expect(ranked.find(r => r.id === 4)!.score).toBeCloseTo(0.5, 10); // scoring is unchanged: stopwords still count when the query is informative
  });
  it("empty / punctuation-only queries are not 'low information' (unchanged behaviour)", () => {
    expect(isLowInformationQuery("")).toBe(false); expect(isLowInformationQuery("?!... ---")).toBe(false); expect(isLowInformationQuery("2026")).toBe(false);
  });
});
