import { describe, expect, it } from "vitest";
import { normalizeRetrievalTerms, scoreRetrievalCandidate } from "./retrieval";

describe("Gate A retrieval fusion acceptance", () => {
  it("normalizes query terms without manufacturing short/noise tokens", () => {
    expect(normalizeRetrievalTerms("  Murugan, AI + RAG! an of  ")).toEqual(["murugan", "rag"]);
  });

  it("uses lexical fallback when semantic vectors are unavailable", () => {
    const result = scoreRetrievalCandidate({
      content: "Murugan devotional knowledge and temple guidance",
      terms: ["murugan", "temple"],
      queryVector: null,
      candidateVector: null,
    });
    expect(result.retrievalMethod).toBe("lexical");
    expect(result.lexicalScore).toBe(1);
    expect(result.semanticScore).toBe(0);
    expect(result.score).toBe(1);
  });

  it("labels semantic-only evidence when vectors match but terms do not", () => {
    const result = scoreRetrievalCandidate({
      content: "spiritual pilgrimage guidance",
      terms: ["murugan"],
      queryVector: [1, 0],
      candidateVector: [1, 0],
    });
    expect(result.retrievalMethod).toBe("semantic");
    expect(result.lexicalScore).toBe(0);
    expect(result.semanticScore).toBe(1);
    expect(result.score).toBeCloseTo(0.65, 8);
  });

  it("labels true hybrid evidence and applies the governed 35/65 fusion weights", () => {
    const result = scoreRetrievalCandidate({
      content: "Murugan temple history",
      terms: ["murugan", "temple"],
      queryVector: [1, 0],
      candidateVector: [1, 0],
    });
    expect(result.retrievalMethod).toBe("hybrid");
    expect(result.lexicalScore).toBe(1);
    expect(result.semanticScore).toBe(1);
    expect(result.score).toBe(1);
  });

  it("falls back to lexical evidence when vector dimensions are incompatible", () => {
    const result = scoreRetrievalCandidate({
      content: "Murugan",
      terms: ["murugan"],
      queryVector: [1],
      candidateVector: [1, 0],
    });
    expect(result.retrievalMethod).toBe("lexical");
    expect(result.lexicalScore).toBe(1);
    expect(result.semanticScore).toBe(0);
    expect(result.score).toBe(1);
  });

  it("returns zero evidence when neither lexical nor semantic signal exists", () => {
    const result = scoreRetrievalCandidate({
      content: "unrelated content",
      terms: ["murugan"],
      queryVector: null,
      candidateVector: null,
    });
    expect(result.retrievalMethod).toBe("lexical");
    expect(result.score).toBe(0);
  });
});
