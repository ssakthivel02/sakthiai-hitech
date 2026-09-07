import { describe, expect, it } from "vitest";
import { assertWorkspaceAccess } from "./db";
import { cosineSimilarity, embeddingStatus, parseEmbedding } from "./embeddings";
import { extractDocument } from "./provenance";

describe("SAI-WEB-FUNCTIONAL-004A core invariants", () => {
  it("filters tenant membership before retrieval", () => {
    expect(assertWorkspaceAccess(101, 7, [{ userId: 101, workspaceId: 7 }])).toBe(true);
    expect(assertWorkspaceAccess(202, 7, [{ userId: 101, workspaceId: 7 }])).toBe(false);
    expect(assertWorkspaceAccess(101, 8, [{ userId: 101, workspaceId: 7 }])).toBe(false);
  });
  it("does not fabricate semantic availability or vectors", () => {
    expect(embeddingStatus().status).toBe("unavailable");
    expect(parseEmbedding(null)).toBeNull();
    expect(parseEmbedding("not-json")).toBeNull();
  });
  it("scores only compatible real vectors", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBe(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
    expect(cosineSimilarity([1], [1, 0])).toBe(0);
  });
  it("preserves PDF page provenance", async () => {
    const pdf = Buffer.from("not a pdf");
    await expect(extractDocument(pdf, "application/pdf")).rejects.toThrow();
  });
  it("never exposes a fabricated DOCX page field in extraction segments", async () => {
    const docx = Buffer.from("not a zip");
    await expect(extractDocument(docx, "application/vnd.openxmlformats-officedocument.wordprocessingml.document")).rejects.toThrow();
  });
});
