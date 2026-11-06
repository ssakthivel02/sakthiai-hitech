import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDatabase, skipMysqlSuite, type TestDatabase } from "./testing/mysqlTestDb";
import { documentChunks, documents } from "../drizzle/schema";
import { backfillSearchText, fetchRetrievalCandidates, searchTextFor, searchWorkspaceChunks } from "./retrievalStore";
import { normalizeRetrievalText } from "./retrieval";

const TA = "முருகன் கோவில் பழநியில் உள்ளது. கோவில் காலை ஆறு மணிக்குத் திறக்கப்படும்.";
const TANGLISH = "palani murugan kovil kaalai aaru manikku thirakkum. kovil malai mel ulladhu.";
const OTHER_TENANT_TA = "ரகசிய ஆவணம் முருகன் கோவில் பழநி TENANT2";

describe.skipIf(skipMysqlSuite())("Tamil/Tanglish retrieval on real SQL", { timeout: 30_000 }, () => {
  let database: TestDatabase; let db: TestDatabase["db"];
  const doc = async (workspaceId: number, filename: string, hash: string) => {
    await db.insert(documents).values({ workspaceId, filename, mimeType: "text/plain", storageKey: null, extractedText: "x", contentHash: hash, pageCount: 1 });
    return Number((((await db.execute(sql`SELECT LAST_INSERT_ID() id`)) as unknown as [Array<{ id: number }>])[0][0]).id);
  };
  const chunk = async (workspaceId: number, documentId: number, index: number, content: string, searchText: string | null) =>
    db.insert(documentChunks).values({ documentId, workspaceId, chunkIndex: index, content, page: 1, searchText, embeddingJson: null, embeddingModel: null });
  const files = async (workspaceId: number, query: string) => (await searchWorkspaceChunks(db, workspaceId, query, null)).map(r => r.filename);

  beforeAll(async () => {
    database = await createTestDatabase(); db = database.db;
    const d1 = await doc(1, "ta.txt", "a1"); await chunk(1, d1, 0, TA, searchTextFor(TA));
    const d2 = await doc(1, "tanglish.txt", "a2"); await chunk(1, d2, 0, TANGLISH, searchTextFor(TANGLISH));
    const d3 = await doc(1, "english.txt", "a3"); await chunk(1, d3, 0, "Quarterly refund policy and the leave policy handbook", searchTextFor("Quarterly refund policy and the leave policy handbook"));
    const d4 = await doc(2, "tenant2-ta.txt", "b1"); await chunk(2, d4, 0, OTHER_TENANT_TA, searchTextFor(OTHER_TENANT_TA));
    // legacy rows (no searchText) and pre-0019 rows (normalized text only, no transliteration block)
    const d5 = await doc(1, "legacy-null.txt", "c1"); await chunk(1, d5, 0, "legacy கோவில் row", null);
    const d6 = await doc(1, "pre0019.txt", "c2"); await chunk(1, d6, 0, "pre nineteen kovil row ulladhu", normalizeRetrievalText("pre nineteen kovil row ulladhu"));
  });
  afterAll(async () => { await database?.close(); });

  it("searchText keeps the normalized content and appends a marked, space-delimited key block", () => {
    const text = searchTextFor("Murugan கோவில்");
    expect(text.startsWith(normalizeRetrievalText("Murugan கோவில்"))).toBe(true);
    expect(text).toContain("~tl~"); expect(text).toContain(" l:mrkn "); expect(text).toContain(" t:kvl ");
  });

  it("a Tanglish query reaches a Tamil-script chunk through the SQL prefilter, and a Tamil query reaches a Tanglish chunk", async () => {
    const a = await files(1, "kovil kaalai thirakkum");
    expect(a).toContain("ta.txt"); expect(a[0]).toBe("tanglish.txt"); // exact words outrank transliteration-only
    const b = await files(1, "மலை மேல் கோவில் எங்கே");
    expect(b[0]).toBe("tanglish.txt"); expect(b).toContain("ta.txt");
    const candidates = await fetchRetrievalCandidates(db, 1, "murugan", null);
    expect(candidates.map(c => c.document.filename)).toEqual(expect.arrayContaining(["ta.txt", "tanglish.txt"]));
  });

  it("is tenant-safe: workspace 2 never sees workspace 1 chunks and vice versa, even via transliteration keys", async () => {
    const two = await files(2, "murugan kovil pazhani");
    expect(two).toEqual(["tenant2-ta.txt"]);
    expect(await files(1, "tenant2")).toEqual([]);
    for (const q of ["murugan kovil", "முருகன் கோவில்"]) expect((await files(1, q)).includes("tenant2-ta.txt")).toBe(false);
  });

  it("English-only data is not polluted: no transliteration match between Latin words", async () => {
    expect(await files(1, "leave policy")).toEqual(["english.txt"]);
    expect(await files(1, "love")).toEqual([]);
  });

  it("stopword-only queries return nothing without scanning anything", async () => {
    for (const q of ["what is the", "என்ன அது", "enna athu"]) expect(await files(1, q)).toEqual([]);
    expect(await fetchRetrievalCandidates(db, 1, "what is the", { model: "m" })).toEqual([]);
  });

  it("legacy NULL rows still retrieve; pre-0019 rows lack cross-script keys until backfill, then upgrade idempotently", async () => {
    expect(await files(1, "கோவில் legacy")).toContain("legacy-null.txt");
    // before backfill: the pre-0019 row is findable by its own words but NOT cross-script
    expect(await files(1, "ஊள்ளது")).not.toContain("pre0019.txt");
    expect(await files(1, "கோவில்")).not.toContain("pre0019.txt");
    const updated = await backfillSearchText(db, { batchSize: 2 });
    expect(updated).toBeGreaterThanOrEqual(2); // the NULL row and the pre-0019 row
    expect(await backfillSearchText(db)).toBe(0); // idempotent
    expect(await files(1, "கோவில்")).toContain("pre0019.txt"); // now found through the t:/l: key block
    const rows = (((await db.execute(sql`SELECT COUNT(*) n FROM documentChunks WHERE searchText IS NULL OR searchText NOT LIKE '%~tl~%'`)) as unknown as [Array<{ n: number }>])[0][0]);
    expect(Number(rows.n)).toBe(0);
  });
});
