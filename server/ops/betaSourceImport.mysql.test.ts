import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createTestDatabase, skipMysqlSuite, type TestDatabase } from "../testing/mysqlTestDb";
import { documentChunks, documents, users, workspaces } from "../../drizzle/schema";
import { loginAccessPolicy } from "../_core/authAccess";
import { searchWorkspaceChunks } from "../retrievalStore";
import { applyImport, confirmationToken, ImportRefusal, loadCorpus, planImport, verifyImport, type LoadedCorpus } from "./betaSourceImport";

describe.skipIf(skipMysqlSuite())("operator-only synthetic source import on real SQL", () => {
  let database: TestDatabase;
  let db: TestDatabase["db"];
  let corpus: LoadedCorpus;
  const ws: Record<string, number> = {};
  const policy = loginAccessPolicy({ AUTH_ALLOWED_SUBJECTS: "sub-a,sub-b" }, true);

  const counts = async (workspaceId: number) => {
    const d = await db.select({ id: documents.id }).from(documents).where(eq(documents.workspaceId, workspaceId));
    const c = await db.select({ id: documentChunks.id }).from(documentChunks).where(eq(documentChunks.workspaceId, workspaceId));
    return { documents: d.length, chunks: c.length };
  };
  const totalRows = async () => {
    const [d] = (await db.execute(sql`SELECT COUNT(*) n FROM documents`)) as unknown as [Array<{ n: number }>];
    const [c] = (await db.execute(sql`SELECT COUNT(*) n FROM documentChunks`)) as unknown as [Array<{ n: number }>];
    return { documents: Number(d[0].n), chunks: Number(c[0].n) };
  };
  const apply = async (ids: number[], overrides: Partial<{ confirm: string; expectDatabase: string }> = {}) => {
    const plan = await planImport({ db, corpus, workspaceIds: ids, policy });
    return applyImport({ db, corpus, plan, confirm: overrides.confirm ?? confirmationToken(corpus, ids, plan.databaseName), expectDatabase: overrides.expectDatabase ?? plan.databaseName });
  };

  beforeAll(async () => {
    database = await createTestDatabase();
    db = database.db;
    corpus = await loadCorpus(path.resolve(process.cwd(), "release/beta-sources"));
    await db.insert(users).values([{ openId: "sub-a", email: "a@example.test" }, { openId: "sub-b", email: "b@example.test" }, { openId: "sub-outsider", email: "c@example.test" }]);
    const rows = await db.select({ id: users.id, openId: users.openId }).from(users);
    const uid = Object.fromEntries(rows.map(r => [r.openId, r.id]));
    await db.insert(workspaces).values([
      { ownerUserId: uid["sub-a"], name: "beta A", slug: "beta-a" },
      { ownerUserId: uid["sub-b"], name: "beta B", slug: "beta-b" },
      { ownerUserId: uid["sub-outsider"], name: "not designated", slug: "outsider" },
    ]);
    for (const r of await db.select({ id: workspaces.id, slug: workspaces.slug }).from(workspaces)) ws[r.slug] = r.id;
  }, 120_000);
  afterAll(async () => { await database?.close(); });

  it("dry run plans every document and writes nothing", async () => {
    const before = await totalRows();
    const plan = await planImport({ db, corpus, workspaceIds: [ws["beta-a"]], policy });
    expect(plan.ok).toBe(true);
    expect(plan.workspaces[0].toInsert).toHaveLength(corpus.documents.length);
    expect(await totalRows()).toEqual(before);
  });

  it("rejects a workspace whose owner is not on the allowlist, and a mixed list fails as a whole with zero writes", async () => {
    const plan = await planImport({ db, corpus, workspaceIds: [ws["beta-a"], ws["outsider"]], policy });
    expect(plan.ok).toBe(false);
    expect(plan.reasons.join(" ")).toMatch(new RegExp(`workspace ${ws["outsider"]}: owner is not on the beta allowlist`));
    await expect(apply([ws["beta-a"], ws["outsider"]])).rejects.toBeInstanceOf(ImportRefusal);
    expect(await totalRows()).toEqual({ documents: 0, chunks: 0 });
  });

  it("rejects unknown workspaces, duplicate ids, an empty list and non-allowlist policies", async () => {
    expect((await planImport({ db, corpus, workspaceIds: [9999], policy })).reasons.join(" ")).toMatch(/not found/);
    expect((await planImport({ db, corpus, workspaceIds: [ws["beta-a"], ws["beta-a"]], policy })).ok).toBe(false);
    expect((await planImport({ db, corpus, workspaceIds: [], policy })).ok).toBe(false);
    for (const open of [loginAccessPolicy({ AUTH_OPEN_SIGNUP: "true" }, true), loginAccessPolicy({}, true)]) {
      const plan = await planImport({ db, corpus, workspaceIds: [ws["beta-a"]], policy: open });
      expect(plan.ok).toBe(false);
      expect(plan.reasons.join(" ")).toMatch(/explicit allowlist/);
    }
    expect(await totalRows()).toEqual({ documents: 0, chunks: 0 });
  });

  it("refuses a wrong token or wrong database name before any write", async () => {
    await expect(apply([ws["beta-a"]], { confirm: "IMPORT-0000000000000000" })).rejects.toThrow(/confirmation token/);
    await expect(apply([ws["beta-a"]], { expectDatabase: "some_other_db" })).rejects.toThrow(/expect-database/);
    // a token minted for a different workspace set is not accepted
    await expect(apply([ws["beta-a"]], { confirm: confirmationToken(corpus, [ws["beta-b"]], database.name) })).rejects.toThrow(/confirmation token/);
    expect(await totalRows()).toEqual({ documents: 0, chunks: 0 });
  });

  it("applies to the designated workspace only, scoped by workspaceId, with no storage key and no embeddings", async () => {
    const report = await apply([ws["beta-a"]]);
    expect(report.totals.inserted).toBe(corpus.documents.length);
    const a = await counts(ws["beta-a"]);
    expect(a.documents).toBe(corpus.documents.length);
    expect(a.chunks).toBeGreaterThanOrEqual(corpus.documents.length);
    expect(await counts(ws["beta-b"])).toEqual({ documents: 0, chunks: 0 });
    expect(await counts(ws["outsider"])).toEqual({ documents: 0, chunks: 0 });
    const docs = await db.select().from(documents);
    expect(docs.every(d => d.storageKey === null && d.workspaceId === ws["beta-a"] && d.mimeType === "text/plain")).toBe(true);
    const chunks = await db.select().from(documentChunks);
    expect(chunks.every(c => c.workspaceId === ws["beta-a"] && c.embeddingJson === null && c.searchText && c.searchText.length > 0)).toBe(true);
    expect((await verifyImport(db, corpus, ws["beta-a"])).ok).toBe(true);
  });

  it("is idempotent: a second apply inserts nothing and changes no row counts", async () => {
    const before = await totalRows();
    const report = await apply([ws["beta-a"]]);
    expect(report.totals).toEqual({ inserted: 0, alreadyPresent: corpus.documents.length, chunksWritten: 0 });
    expect(await totalRows()).toEqual(before);
  });

  it("repairs only what is missing, and survives two concurrent runs without duplicates", async () => {
    // remove one document (and its chunks) from A, then import to A and B concurrently from two runs
    const victim = (await db.select().from(documents).where(eq(documents.workspaceId, ws["beta-a"])).limit(1))[0];
    await db.delete(documentChunks).where(eq(documentChunks.documentId, victim.id));
    await db.delete(documents).where(eq(documents.id, victim.id));
    const results = await Promise.allSettled([apply([ws["beta-a"], ws["beta-b"]]), apply([ws["beta-a"], ws["beta-b"]])]);
    expect(results.every(r => r.status === "fulfilled")).toBe(true);
    expect((await counts(ws["beta-a"])).documents).toBe(corpus.documents.length);
    expect((await counts(ws["beta-b"])).documents).toBe(corpus.documents.length);
    const dupes = (await db.execute(sql`SELECT workspaceId, contentHash, COUNT(*) n FROM documents GROUP BY workspaceId, contentHash HAVING n > 1`)) as unknown as [unknown[]];
    expect(dupes[0]).toHaveLength(0);
    expect(await counts(ws["outsider"])).toEqual({ documents: 0, chunks: 0 });
  });

  it("makes imported English and Tamil sources retrievable in their workspace and invisible to every other", async () => {
    const en = await searchWorkspaceChunks(db, ws["beta-a"], "library membership late fee per day", null);
    expect(en.length).toBeGreaterThan(0);
    expect(en[0].filename).toBe("synthetic-en-library-membership.txt");
    const ta = await searchWorkspaceChunks(db, ws["beta-b"], "பயிற்சி கட்டணம் ரூபாய்", null);
    expect(ta.length).toBeGreaterThan(0);
    expect(ta.some(hit => hit.filename === "synthetic-ta-center-courses.txt")).toBe(true);
    expect(await searchWorkspaceChunks(db, ws["outsider"], "library membership late fee per day", null)).toHaveLength(0);
  });
});
