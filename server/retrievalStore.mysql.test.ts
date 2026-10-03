import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDatabase, skipMysqlSuite, type TestDatabase } from "./testing/mysqlTestDb";
import { documentChunks, documents, workspaces } from "../drizzle/schema";
import { backfillSearchText, fetchRetrievalCandidates, likePattern, searchWorkspaceChunks, searchTextFor } from "./retrievalStore";
import { serializeEmbedding } from "./embeddings";

const TAMIL = "முருகன் கோவில் பழநியில் உள்ளது; வழிபாடு காலை ஆறு மணிக்கு தொடங்கும்.";
const ENGLISH = "The Aruvikkarai reservoir inspection happens every March by the district engineer.";
const MIXED = "திருவிழா (festival) schedule Thaipusam 2027 அறிவிப்பு";
const FILLER_WORDS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"];
const filler = (n: number) => `${FILLER_WORDS[n % 8]} routine log entry ${n} ${FILLER_WORDS[(n * 3) % 8]} nothing relevant`;

describe.skipIf(skipMysqlSuite())("tenant-safe retrieval on real SQL (1,200+ chunks per large workspace)", () => {
  let database: TestDatabase;
  let db: TestDatabase["db"];
  const ids: Record<string, number> = {};

  async function insertDoc(workspaceId: number, filename: string, hash: string, storageKey: string | null) {
    await db.insert(documents).values({ workspaceId, filename, mimeType: "text/plain", storageKey, extractedText: "x", contentHash: hash, pageCount: 1 });
    const [rows] = (await db.execute(sql`SELECT LAST_INSERT_ID() id`)) as unknown as [Array<{ id: number }>];
    return Number(rows[0].id);
  }
  async function insertChunks(workspaceId: number, documentId: number, contents: Array<{ content: string; vector?: number[]; model?: string; legacy?: boolean }>, startIndex = 0) {
    const values = contents.map((item, offset) => ({
      documentId, workspaceId, chunkIndex: startIndex + offset, content: item.content, page: 1,
      searchText: item.legacy ? null : searchTextFor(item.content),
      embeddingJson: item.vector ? serializeEmbedding(item.vector) : null, embeddingModel: item.model ?? null,
    }));
    for (let i = 0; i < values.length; i += 300) await db.insert(documentChunks).values(values.slice(i, i + 300));
  }
  const search = (workspaceId: number, query: string, semantic: { vector: number[]; model: string } | null = null) => searchWorkspaceChunks(db, workspaceId, query, semantic);

  beforeAll(async () => {
    database = await createTestDatabase();
    db = database.db;
    await db.insert(workspaces).values([{ ownerUserId: 1, name: "one", slug: "one" }, { ownerUserId: 2, name: "two", slug: "two" }]);
    ids.d1 = await insertDoc(1, "ws1-big.txt", "h1", "1/1/ws1-big.txt");
    await insertChunks(1, ids.d1, Array.from({ length: 1200 }, (_, n) => ({ content: filler(n) })));
    // planted LAST so any "first 500 rows" strategy would miss them
    ids.d1b = await insertDoc(1, "ws1-facts.txt", "h2", "1/1/ws1-facts.txt");
    await insertChunks(1, ids.d1b, [{ content: TAMIL }, { content: ENGLISH }, { content: MIXED }]);
    ids.d2 = await insertDoc(2, "ws2-secret.txt", "h3", "2/2/ws2-secret.txt");
    await insertChunks(2, ids.d2, [
      ...Array.from({ length: 300 }, (_, n) => ({ content: filler(n + 5000) })),
      { content: "முருகன் கோவில் ரகசிய TENANT2-ONLY-MARKER ஆவணம்" },
      { content: "Aruvikkarai reservoir confidential zephyrbudget TENANT2-ONLY-MARKER" },
    ]);
  });
  afterAll(async () => { await database?.close(); });

  it("migration created the retrieval/storage indexes", async () => {
    const [rows] = (await db.execute(sql`SELECT TABLE_NAME t, INDEX_NAME i FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ${database.name} AND INDEX_NAME <> 'PRIMARY'`)) as unknown as [Array<{ t: string; i: string }>];
    const have = new Set(rows.map(r => `${r.t}.${r.i}`));
    for (const expected of ["documentChunks.chunks_workspace_document_idx", "documentChunks.documentChunks_documentId_chunkIndex_idx", "documents.documents_workspaceId_createdAt_idx", "documents.documents_workspace_hash_idx", "documents.documents_storageKey_idx", "creatorAssets.creatorAssets_storageKey_idx", "messages.messages_workspaceId_conversationId_createdAt_idx", "workspaceMembers.workspaceMembers_userId_workspaceId_idx", "projects.projects_workspaceId_idx"]) expect(have, expected).toContain(expected);
  });

  it("actual query plans use those indexes (workspace scoping and storageKey lookups are not full scans)", async () => {
    const plan = async (query: string) => { const [rows] = (await db.execute(sql.raw(`EXPLAIN ${query}`))) as unknown as [Array<Record<string, unknown>>]; return rows.map(r => String(r.key ?? "")).join(","); };
    expect(await plan("SELECT id FROM documentChunks WHERE workspaceId = 1")).toContain("chunks_workspace_document_idx");
    expect(await plan("SELECT workspaceId FROM documents WHERE storageKey = '1/1/ws1-big.txt'")).toContain("documents_storageKey_idx");
    expect(await plan("SELECT workspaceId FROM creatorAssets WHERE storageKey = 'k'")).toContain("creatorAssets_storageKey_idx");
    expect(await plan("SELECT id FROM documents WHERE workspaceId = 1 AND contentHash = 'h1'")).toContain("documents_workspace_hash_idx");
  });

  it("finds Tamil, English and mixed evidence that sits beyond the first 500 chunks of a >1,200-chunk workspace", async () => {
    expect((await search(1, "முருகன் கோவில் எங்கு")).map(r => r.filename)).toEqual(["ws1-facts.txt"]);
    const english = await search(1, "reservoir inspection engineer");
    expect(english[0]).toMatchObject({ filename: "ws1-facts.txt", retrievalMethod: "lexical" });
    expect(english[0].content).toBe(ENGLISH);
    const mixed = await search(1, "திருவிழா festival schedule");
    expect(mixed[0].content).toBe(MIXED);
  });

  it("tenant A never sees tenant B (lexical, Tamil, semantic, and shared vocabulary)", async () => {
    for (const q of ["TENANT2-ONLY-MARKER", "confidential zephyrbudget", "ரகசிய ஆவணம்"]) expect(await search(1, q), q).toEqual([]);
    const shared = await search(1, "Aruvikkarai reservoir");
    expect(shared.every(r => r.workspaceId === 1)).toBe(true);
    const two = await search(2, "Aruvikkarai reservoir");
    expect(two.map(r => r.filename)).toEqual(["ws2-secret.txt"]);
    expect(two.every(r => r.workspaceId === 2)).toBe(true);
    // even with an embedding query that exactly matches a tenant-2 vector
    await db.execute(sql`UPDATE documentChunks SET embeddingJson = ${serializeEmbedding([1, 0, 0])}, embeddingModel = 'm1' WHERE workspaceId = 2 AND content LIKE '%zephyrbudget%'`);
    expect(await search(1, "zzzzqqqq", { vector: [1, 0, 0], model: "m1" })).toEqual([]);
    expect((await search(2, "zzzzqqqq", { vector: [1, 0, 0], model: "m1" })).map(r => r.workspaceId)).toEqual([2]);
    // candidate sources are all workspace scoped
    for (const semantic of [null, { model: "m1" }]) for (const row of await fetchRetrievalCandidates(db, 1, "reservoir confidential", semantic)) expect(row.chunk.workspaceId).toBe(1);
  });

  it("lexical-only mode ranks by matched-term coverage deterministically (ties by id) and is repeatable", async () => {
    const a = await search(1, "alpha routine log nothing");
    const b = await search(1, "alpha routine log nothing");
    expect(a.map(r => r.id)).toEqual(b.map(r => r.id));
    expect(a.length).toBe(8);
    for (let i = 1; i < a.length; i += 1) expect(a[i - 1].score > a[i].score || (a[i - 1].score === a[i].score && a[i - 1].id < a[i].id)).toBe(true);
  });

  it("embedding-assisted mode: same-model vectors rerank/extend candidates; other-model and unembedded rows are lexical only", async () => {
    await db.execute(sql`UPDATE documentChunks SET embeddingJson = ${serializeEmbedding([0, 1, 0])}, embeddingModel = 'm1' WHERE workspaceId = 1 AND content = ${ENGLISH}`);
    await db.execute(sql`UPDATE documentChunks SET embeddingJson = ${serializeEmbedding([0, 1, 0])}, embeddingModel = 'other' WHERE workspaceId = 1 AND content = ${TAMIL}`);
    const semanticOnly = await search(1, "qqqqzzzz", { vector: [0, 1, 0], model: "m1" });
    expect(semanticOnly.map(r => [r.content, r.retrievalMethod])).toEqual([[ENGLISH, "semantic"]]); // no lexical overlap at all, still found
    const hybrid = await search(1, "reservoir inspection", { vector: [0, 1, 0], model: "m1" });
    expect(hybrid[0]).toMatchObject({ content: ENGLISH, retrievalMethod: "hybrid" });
    const lexicalOnly = await search(1, "reservoir inspection", null);
    expect(lexicalOnly[0]).toMatchObject({ content: ENGLISH, retrievalMethod: "lexical" });
    const wrongModel = await search(1, "முருகன் கோவில்", { vector: [0, 1, 0], model: "m1" });
    expect(wrongModel[0]).toMatchObject({ content: TAMIL, retrievalMethod: "lexical" });
  });

  it("legacy rows without searchText stay searchable and a backfill makes them SQL-prefilterable, idempotently", async () => {
    const legacyDoc = await insertDoc(1, "legacy.txt", "h-legacy", "1/1/legacy.txt");
    await insertChunks(1, legacyDoc, [{ content: "Legacy kolam rangoli ஓவியம் archive note", legacy: true }]);
    expect((await search(1, "kolam rangoli")).map(r => r.filename)).toEqual(["legacy.txt"]);
    expect(await backfillSearchText(db)).toBe(1);
    expect(await backfillSearchText(db)).toBe(0);
    expect((await search(1, "kolam rangoli")).map(r => r.filename)).toEqual(["legacy.txt"]);
    const [rows] = (await db.execute(sql`SELECT COUNT(*) c FROM documentChunks WHERE searchText IS NULL`)) as unknown as [Array<{ c: number }>];
    expect(Number(rows[0].c)).toBe(0);
  });

  it("query text can never act as a LIKE pattern", async () => {
    expect(likePattern("a_b%c!")).toBe("%a!_b!%c!!%");
    await insertChunks(1, ids.d1b, [{ content: "pattern axb literal" }, { content: "pattern a_b literal" }], 10);
    const found = await search(1, "a_b");
    expect(found.map(r => r.content)).toEqual(["pattern a_b literal"]);
    expect(await search(1, "%")).toEqual([]);
    // "%" is stripped by tokenisation; "100" is an ordinary term. It must match only rows that really contain "100", never "everything".
    const hundred = await search(1, "100%");
    expect(hundred.length).toBeGreaterThan(0);
    expect(hundred.every(r => r.content.includes("100"))).toBe(true);
  });

  it("matches are Unicode-normalised the same way as ingestion (NFD query/content, zero-width characters)", async () => {
    const nfd = "Café reservoir naïve";
    await insertChunks(1, ids.d1b, [{ content: nfd }, { content: "வழி‍பாடு time​table" }], 20);
    expect((await search(1, "café")).some(r => r.content === nfd)).toBe(true);
    expect((await search(1, "timetable")).some(r => r.content.includes("time​table"))).toBe(true);
  });

  it("when more rows match than the candidate limit, SQL keeps the best-covered rows, not the oldest", async () => {
    const bulk = await insertDoc(1, "bulk.txt", "h-bulk", "1/1/bulk.txt");
    await insertChunks(1, bulk, Array.from({ length: 260 }, (_, n) => ({ content: `bulkterm filler number ${n}` })));
    await insertChunks(1, bulk, [{ content: "bulkterm and bulkpartner together" }], 260); // highest id, best coverage
    const top = await search(1, "bulkterm bulkpartner");
    expect(top[0].content).toBe("bulkterm and bulkpartner together");
    expect((await fetchRetrievalCandidates(db, 1, "bulkterm bulkpartner", null)).length).toBeLessThanOrEqual(200 + 500); // lexical cap + legacy cap
  });

  it("bounded: an enormous multi-term query is capped and an empty/punctuation query returns nothing without a global scan", async () => {
    expect(await search(1, "!!! ??? ...")).toEqual([]);
    const many = Array.from({ length: 200 }, (_, n) => `term${n}`).join(" ");
    expect((await search(1, `${many} reservoir`)).every(r => r.workspaceId === 1)).toBe(true);
  });
});
