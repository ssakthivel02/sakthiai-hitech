import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { modelUnavailableMessage } from "../grounding";
import {
  deriveArtifactTitle, excerptText, insertedId, isSaveableAnswer, MAX_ARTIFACT_TITLE_CODE_POINTS, parseCitations,
  rankArtifactCandidates, sanitizeTitle, snippetFor, toFileReference, truncateText,
} from "./store";
import { groupDocumentHits, type ChunkHit } from "./workspaceSearch";

// Invisible/bidi characters are built from code points on purpose: they must never be literal characters in source.
const RLO = String.fromCharCode(0x202e);
const ZWSP = String.fromCharCode(0x200b);
const ZWJ = String.fromCharCode(0x200d);
const LS = String.fromCharCode(0x2028);

const TAMIL = "முருகன் கோவில் காலை ஆறு மணிக்கு திறக்கும்.";
const day = (n: number) => new Date(Date.UTC(2026, 9, n));
const row = (id: number, title: string, content: string, extra: Partial<{ projectId: number | null }> = {}) => ({ id, projectId: extra.projectId ?? null, kind: "chat_answer", title, language: "en" as const, updatedAt: day(id), content });

describe("truncateText / excerptText: never cut inside a Tamil grapheme", () => {
  it("does not emit a bare consonant when the whole grapheme does not fit", () => {
    const ko = "கொ"; // consonant + vowel sign O = ONE grapheme, two code points
    expect(Array.from(ko)).toHaveLength(2);
    expect(truncateText(ko, 1)).toBe("");
    expect(truncateText(ko, 2)).toBe(ko);
  });
  it("every budget yields a whole-grapheme prefix of the original", () => {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    const parts = [...segmenter.segment(TAMIL)].map(s => s.segment);
    for (let budget = 0; budget <= Array.from(TAMIL).length; budget += 1) {
      let used = 0; let expected = "";
      for (const part of parts) { const cost = Array.from(part).length; if (used + cost > budget) break; expected += part; used += cost; }
      expect(truncateText(TAMIL, budget).trimEnd()).toBe(expected.trimEnd());
    }
  });
  it("adds an ellipsis only when something was cut, and stays within the budget", () => {
    expect(excerptText("short", 10)).toBe("short");
    const cut = excerptText(TAMIL, 12);
    expect(cut.endsWith("…")).toBe(true);
    expect(Array.from(cut).length).toBeLessThanOrEqual(12);
  });
});

describe("titles", () => {
  it("strips controls, bidi overrides, line separators and zero-width spaces; keeps ZWJ; collapses whitespace", () => {
    expect(sanitizeTitle(`  Temple${RLO} times${ZWSP}\n\tnow${LS}ok `)).toBe("Temple times now ok");
    expect(sanitizeTitle(`a${ZWJ}b`)).toBe(`a${ZWJ}b`);
  });
  it("is bounded by the column width in code points", () => {
    expect(Array.from(sanitizeTitle("a".repeat(500))).length).toBe(MAX_ARTIFACT_TITLE_CODE_POINTS);
    expect(Array.from(sanitizeTitle("ம".repeat(500))).length).toBeLessThanOrEqual(MAX_ARTIFACT_TITLE_CODE_POINTS);
  });
  it("derives a plain title from the first meaningful markdown line", () => {
    expect(deriveArtifactTitle("## **Temple** timings\n\nbody")).toBe("Temple timings");
    expect(deriveArtifactTitle("\n\n- first item\n- second")).toBe("first item");
    expect(deriveArtifactTitle("1. Step one")).toBe("Step one");
    expect(deriveArtifactTitle(`${TAMIL}\nmore`)).toBe(TAMIL);
    expect(deriveArtifactTitle("   \n  ")).toBe("Saved answer");
  });
});

describe("isSaveableAnswer: only a real grounded model answer may become an artifact", () => {
  const evidence = [{ filename: "a.txt", documentId: 1, excerpt: "x" }, { filename: "a.txt", documentId: 1, excerpt: "y" }];
  it("accepts a normal answer with citations", () => { expect(isSaveableAnswer("It opens at 6am. [1]", evidence)).toBe(true); });
  it("rejects empty text, no citations, and the INSUFFICIENT_EVIDENCE sentinel", () => {
    expect(isSaveableAnswer("   ", evidence)).toBe(false);
    expect(isSaveableAnswer("It opens at 6am.", [])).toBe(false);
    expect(isSaveableAnswer("INSUFFICIENT_EVIDENCE", evidence)).toBe(false);
  });
  it("rejects the MODEL_UNAVAILABLE fallback in either language even though it is persisted WITH citations", () => {
    expect(isSaveableAnswer(modelUnavailableMessage("en", evidence.length), evidence)).toBe(false);
    expect(isSaveableAnswer(modelUnavailableMessage("ta", evidence.length), evidence)).toBe(false);
    // a different evidence count is a different string: still a normal answer
    expect(isSaveableAnswer(modelUnavailableMessage("en", 9), evidence)).toBe(true);
  });
});

describe("parseCitations: stored evidence is never trusted blindly", () => {
  it("keeps well-formed citations and drops everything else", () => {
    const good = { filename: "a.txt", documentId: 3, page: 1, excerpt: "text" };
    const parsed = parseCitations(JSON.stringify([good, null, 7, "x", { filename: "b" }, { filename: "c", documentId: "9", excerpt: "e" }, { filename: "d", documentId: Number.NaN, excerpt: "e" }]));
    expect(parsed).toEqual([good]);
  });
  it("returns [] for null, empty, non-array and invalid JSON", () => {
    for (const value of [null, undefined, "", "{}", "not json", "\"s\""]) expect(parseCitations(value as string | null)).toEqual([]);
  });
});

describe("snippetFor", () => {
  it("chooses the paragraph with the most matching terms", () => {
    const content = "Intro line about nothing.\nThe reservoir inspection happens every March.\nUnrelated closing remark.";
    expect(snippetFor(content, ["reservoir", "inspection"])).toBe("The reservoir inspection happens every March.");
  });
  it("falls back to the first paragraph and bounds length", () => {
    expect(snippetFor("first\nsecond", ["zzz"])).toBe("first");
    expect(Array.from(snippetFor("word ".repeat(200), ["word"], 50)).length).toBeLessThanOrEqual(50);
  });
  it("matches Tamil terms after NFKC normalisation", () => {
    expect(snippetFor(`வணக்கம்\n${TAMIL}`, ["முருகன்"])).toBe(TAMIL);
  });
});

describe("rankArtifactCandidates (same scorer and normalisation as chunk retrieval)", () => {
  const rows = [
    row(1, "Reservoir report", "The Aruvikkarai reservoir inspection happens every March."),
    row(2, "Temple note", TAMIL),
    row(3, "Budget", "Quarterly budget review for the district office."),
  ];
  it("ranks English matches and reports a lexical method (never semantic)", () => {
    const hits = rankArtifactCandidates(rows, "reservoir inspection");
    expect(hits.map(h => h.id)).toEqual([1]);
    expect(hits[0]).toMatchObject({ retrievalMethod: "lexical", title: "Reservoir report" });
    expect(hits[0].score).toBeGreaterThan(0);
    expect(hits[0].snippet).toContain("reservoir inspection");
    expect(Object.keys(hits[0]).sort()).toEqual(["id", "kind", "language", "projectId", "retrievalMethod", "score", "snippet", "title", "updatedAt"]);
  });
  it("finds Tamil content from a Tamil query and from a Tanglish query (cross-script key, half weight)", () => {
    expect(rankArtifactCandidates(rows, "முருகன் கோவில்").map(h => h.id)).toEqual([2]);
    const tanglish = rankArtifactCandidates(rows, "murugan kovil");
    expect(tanglish.map(h => h.id)).toEqual([2]);
    expect(tanglish[0].score).toBeCloseTo(0.5, 5);
  });
  it("matches on the title as well as the body", () => {
    expect(rankArtifactCandidates(rows, "budget").map(h => h.id)).toEqual([3]);
  });
  it("returns nothing for stopword-only, empty and punctuation-only queries", () => {
    for (const query of ["what is the", "என்ன அது", "", "   ", "%%%", "!!!"]) expect(rankArtifactCandidates(rows, query)).toEqual([]);
  });
  it("is deterministic: equal scores order newer (higher id) first; limit is honoured", () => {
    const tied = [row(5, "alpha note", "alpha"), row(9, "alpha note", "alpha"), row(7, "alpha note", "alpha")];
    expect(rankArtifactCandidates(tied, "alpha").map(h => h.id)).toEqual([9, 7, 5]);
    expect(rankArtifactCandidates(tied, "alpha", 2).map(h => h.id)).toEqual([9, 7]);
    expect(rankArtifactCandidates([...tied].reverse(), "alpha").map(h => h.id)).toEqual([9, 7, 5]);
  });
  it("prefers the artifact that matches more query terms", () => {
    const hits = rankArtifactCandidates([row(1, "n", "alpha only"), row(2, "n", "alpha bravo both")], "alpha bravo");
    expect(hits.map(h => h.id)).toEqual([2, 1]);
  });
});

describe("insertedId", () => {
  it("reads mysql2's ResultSetHeader and tolerates anything else", () => {
    expect(insertedId([{ insertId: 42 }, []])).toBe(42);
    for (const value of [undefined, null, [], [{}], [{ insertId: 0 }], [{ insertId: "7" }], [{ insertId: 1.5 }]]) expect(insertedId(value)).toBeUndefined();
  });
});

describe("groupDocumentHits", () => {
  const hit = (documentId: number, score: number, content = "text", method: ChunkHit["retrievalMethod"] = "lexical"): ChunkHit => ({ documentId, filename: `d${documentId}.txt`, mimeType: "text/plain", page: 1, section: null, content, score, retrievalMethod: method });
  it("keeps the best (first) chunk per document, preserves rank order and honours the limit", () => {
    const grouped = groupDocumentHits([hit(2, 0.9, "best two"), hit(1, 0.8), hit(2, 0.7, "worse two"), hit(3, 0.5)], 2);
    expect(grouped.map(g => g.documentId)).toEqual([2, 1]);
    expect(grouped[0].snippet).toBe("best two");
  });
  it("keeps the method each hit was actually found by and bounds the snippet", () => {
    const [one] = groupDocumentHits([hit(1, 0.123456789, "word ".repeat(200), "hybrid")]);
    expect(one.retrievalMethod).toBe("hybrid");
    expect(one.score).toBe(0.123457);
    expect(Array.from(one.snippet).length).toBeLessThanOrEqual(240);
  });
});

/** Static guards in the style of tenant-isolation.regression.test.ts; the behavioural proof is artifacts.mysql.test.ts. */
describe("tenant-isolation guards (static)", () => {
  const store = readFileSync(new URL("./store.ts", import.meta.url), "utf8");
  const router = readFileSync(new URL("./router.ts", import.meta.url), "utf8");

  it("every artifacts query is scoped by workspaceId in SQL", () => {
    // list x2 (with/without project filter), get-by-id, search, the source-message lookup used for idempotent saves, and the lifecycle ownership lookups (plain + row-locked)
    expect(store.split("eq(artifacts.workspaceId, workspaceId)").length - 1).toBe(7);
    // the lifecycle writes (update, delete) are workspace-scoped in their own WHERE, and both go through the same ownership gate first
    expect(store.split(".where(and(eq(artifacts.workspaceId, input.workspaceId), eq(artifacts.id, input.artifactId)))").length - 1).toBe(2);
    // update uses the plain gate; delete, attachFile and detachFile use the row-locked gate inside their transaction
    expect(store.match(/await loadManageable\(/g)!.length).toBe(1);
    expect(store.match(/await lockManageable\(/g)!.length).toBe(3);
    expect(store).toContain("row.createdByUserId !== actor.userId && !actor.isWorkspaceOwner");
    expect(store).toContain("eq(projects.workspaceId, input.workspaceId)");
    expect(store.match(/\.from\(artifacts\)/g)!.length).toBe(store.match(/\.from\(artifacts\)[\s\S]*?\.where\(/g)!.length);
  });
  it("file references are scoped by workspace at association AND retrieval, and never read file content", () => {
    // every reference read/write is filtered by the artifact's workspace
    const refQueries = store.match(/\.(from|delete)\(artifactFileReferences\)[\s\S]*?\.where\([\s\S]*?\);/g)!;
    expect(refQueries.length).toBeGreaterThanOrEqual(3);
    for (const q of refQueries) expect(q).toMatch(/eq\(artifactFileReferences\.workspaceId, (input\.)?workspaceId\)|\bscope\b/);
    // association: the document must be in the caller's workspace; retrieval: the join re-applies the same workspace
    expect(store).toContain("eq(documents.id, input.documentId), eq(documents.workspaceId, input.workspaceId)");
    expect(store).toContain(".leftJoin(documents, and(eq(documents.id, artifactFileReferences.documentId), eq(documents.workspaceId, workspaceId)))");
    // only ids/metadata: file content and storage location are never selected for references
    const refSection = store.slice(store.indexOf("// ---- links to existing workspace files"));
    expect(refSection).not.toMatch(/documents\.(extractedText|storageKey)/);
    expect(router).toContain("fileReferences: await listFileReferences(db, input.workspaceId, input.artifactId)");
  });
  it("saving requires the saver to own the conversation and reads an ASSISTANT message of that conversation and workspace", () => {
    expect(store).toContain("eq(conversations.userId, input.userId)");
    expect(store).toContain("eq(conversations.workspaceId, input.workspaceId)");
    expect(store).toContain('eq(messages.role, "assistant")');
    expect(store).toContain("eq(messages.conversationId, input.conversationId)");
    expect(store).toContain("eq(messages.workspaceId, input.workspaceId)");
    expect(store).toContain("eq(projects.workspaceId, input.workspaceId)");
  });
  it("search escapes LIKE input through the shared likePattern and never builds SQL from raw query text", () => {
    expect(store).toContain("likePattern(term)");
    expect(store).not.toMatch(/sql\.raw\(/);
  });
  it("every router procedure is authenticated and checks workspace membership before touching data; the client cannot supply content or citations", () => {
    const procedures = router.match(/\w+: protectedProcedure\b/g)!.length;
    expect(procedures).toBe(8);
    expect(router).not.toContain("publicProcedure");
    expect(router.match(/await requireWorkspace\(ctx\.user\.id, input\.workspaceId\)/g)!.length).toBe(procedures);
    const saveInput = router.slice(router.indexOf("saveFromMessage"), router.indexOf(".mutation("));
    expect(saveInput).not.toMatch(/content|citations/i);
    // update can only change title/project (never content, evidence or provenance); the role comes from the server, never from input
    const updateInput = router.slice(router.indexOf("update: protectedProcedure"), router.indexOf(".mutation(", router.indexOf("update: protectedProcedure")));
    expect(updateInput).not.toMatch(/content|citations|sourceMessageId|createdBy|role|owner/i);
    // update, delete, attachFile, detachFile: the actor's role is always derived server-side
    expect(router.match(/actor: await actorFor\(ctx\.user\.id, input\.workspaceId\)/g)!.length).toBe(4);
    for (const name of ["attachFile", "detachFile"]) {
      const input = router.slice(router.indexOf(`${name}: protectedProcedure`), router.indexOf(".mutation(", router.indexOf(`${name}: protectedProcedure`)));
      expect(input, name).not.toMatch(/content|filename|storageKey|createdBy|role|owner/i);
    }
  });
});

describe("toFileReference (retrieval-time resolution of a linked file)", () => {
  const base = { documentId: 7, addedByUserId: 3, linkedAt: new Date("2026-10-27T00:00:00Z") };
  it("a joined, in-scope document is available with metadata only", () => {
    const uploadedAt = new Date("2026-10-01T00:00:00Z");
    expect(toFileReference({ ...base, docId: 7, filename: "a.pdf", mimeType: "application/pdf", projectId: null, pageCount: 3, uploadedAt }))
      .toEqual({ ...base, status: "available", filename: "a.pdf", mimeType: "application/pdf", projectId: null, pageCount: 3, uploadedAt });
  });
  it("a LEFT JOIN miss (deleted or out-of-scope document) is unavailable and carries no file metadata", () => {
    const resolved = toFileReference({ ...base, docId: null, filename: null, mimeType: null, projectId: null, pageCount: null, uploadedAt: null });
    expect(resolved).toEqual({ ...base, status: "unavailable" });
  });
  it("a partially populated join is treated as unavailable (fails closed)", () => {
    expect(toFileReference({ ...base, docId: 7, filename: "leak.txt", mimeType: null, projectId: 1, pageCount: 1, uploadedAt: new Date() }).status).toBe("unavailable");
  });
});
