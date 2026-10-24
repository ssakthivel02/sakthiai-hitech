import { describe, expect, it } from "vitest";
import { rankChunkCandidates } from "./retrieval";

const row = (id: number, content: string) => ({ chunk: { id, content, embeddingJson: null as string | null }, document: { filename: `f${id}`, mimeType: "text/plain" } });

describe("deterministic ranking", () => {
  it("equal scores are ordered by chunk id regardless of input order", () => {
    const forward = rankChunkCandidates([row(3, "alpha beta"), row(9, "alpha beta"), row(5, "alpha beta")], "alpha beta", null).map(r => r.id);
    const reversed = rankChunkCandidates([row(5, "alpha beta"), row(9, "alpha beta"), row(3, "alpha beta")], "alpha beta", null).map(r => r.id);
    expect(forward).toEqual([3, 5, 9]);
    expect(reversed).toEqual([3, 5, 9]);
  });
  it("higher term coverage beats lower even with a larger id", () => {
    expect(rankChunkCandidates([row(1, "alpha only"), row(2, "alpha beta both")], "alpha beta", null).map(r => r.id)).toEqual([2, 1]);
  });
});
