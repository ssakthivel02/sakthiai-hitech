import { cosineSimilarity } from "./embeddings";

export type RetrievalMethod = "lexical" | "semantic" | "hybrid";

export function normalizeRetrievalTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map(term => term.replace(/[^a-z0-9_-]/g, ""))
    .filter(term => term.length > 2);
}

export function scoreRetrievalCandidate(input: {
  content: string;
  terms: string[];
  queryVector: number[] | null;
  candidateVector: number[] | null;
}): { score: number; retrievalMethod: RetrievalMethod; lexicalScore: number; semanticScore: number } {
  const lexicalHits = input.terms.reduce(
    (count, term) => count + (input.content.toLowerCase().includes(term) ? 1 : 0),
    0,
  );
  const lexicalScore = input.terms.length ? lexicalHits / input.terms.length : 0;
  const hasSemantic = Boolean(
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
