import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDatabase, skipMysqlSuite, type TestDatabase } from "../testing/mysqlTestDb";
import { buildValueLedger, type ValueLedgerDb } from "./valueLedger";

/** Real-SQL Value Ledger: every source table comes from the migrations; rows are synthetic and disposable. */
describe.skipIf(skipMysqlSuite())("Value Ledger on MySQL", () => {
  let database: TestDatabase;
  const db = () => database.db as unknown as ValueLedgerDb;
  const persisted = { GATEWAY_STATE_STORE: "mysql", GATEWAY_COST_UNIT: "INR" };

  beforeAll(async () => { database = await createTestDatabase(); });
  afterAll(async () => { await database?.close(); });
  beforeEach(async () => {
    for (const t of ["providerUsageWindows", "providerUsageHolds", "creatorSpendWindows", "creatorSpendHolds", "messages", "conversations", "documents", "projects"]) {
      await database.db.execute(sql.raw(`DELETE FROM ${t}`));
    }
  });

  async function seed() {
    const e = database.db;
    // model usage: two workspaces on day 1, one on day 2; one released call on day 1
    await e.execute(sql`INSERT INTO providerUsageWindows (workspaceId, windowStart, requests, tokens, cost, estimatedCommits) VALUES (1, '2026-10-20', 3, 3000, 0.120000, 0), (2, '2026-10-20', 1, 500, 0.020000, 1), (1, '2026-10-21', 2, 1000, 0.050000, 0), (1, '2026-10-19', 9, 9, 9, 0)`);
    await e.execute(sql`INSERT INTO providerUsageHolds (id, workspaceId, providerId, windowStart, tokens, cost, state) VALUES
      ('h1', 1, 'external', '2026-10-20', 1000, 0.04, 'COMMITTED'), ('h2', 1, 'external', '2026-10-20', 1000, 0.04, 'COMMITTED'),
      ('h3', 2, 'external', '2026-10-20', 500, 0.02, 'RELEASED'), ('h4', 1, 'local', '2026-10-21', 1000, 0, 'COMMITTED'), ('h5', 1, 'local', '2026-10-21', 1, 0, 'HELD')`);
    // creator: global window plus per-model holds
    await e.execute(sql`INSERT INTO creatorSpendWindows (scope, windowStart, generations, cost) VALUES ('global', '2026-10-21', 2, 1.500000), ('workspace:1', '2026-10-21', 2, 1.500000)`);
    await e.execute(sql`INSERT INTO creatorSpendHolds (id, workspaceId, userId, kind, model, windowStart, cost, state) VALUES
      ('c1', 1, 7, 'image', 'img-model', '2026-10-21', 0.5, 'COMMITTED'), ('c2', 1, 7, 'video', 'vid-model', '2026-10-21', 1.0, 'COMMITTED'), ('c3', 1, 7, 'video', 'vid-model', '2026-10-21', 1.0, 'RELEASED')`);
    // activity: timestamps at the edges of UTC days
    await e.execute(sql`INSERT INTO conversations (workspaceId, userId, title, createdAt) VALUES (1, 7, 't', FROM_UNIXTIME(${Date.parse("2026-10-20T00:00:00Z") / 1000})), (1, 7, 't', FROM_UNIXTIME(${Date.parse("2026-10-21T23:59:59Z") / 1000})), (1, 7, 't', FROM_UNIXTIME(${Date.parse("2026-10-22T00:00:00Z") / 1000}))`);
    for (const [role, at] of [["user", "2026-10-20T08:00:00Z"], ["assistant", "2026-10-20T08:00:05Z"], ["user", "2026-10-21T09:00:00Z"], ["assistant", "2026-10-21T09:00:04Z"], ["assistant", "2026-10-21T23:59:59Z"], ["assistant", "2026-10-19T23:59:59Z"]] as const) {
      await e.execute(sql`INSERT INTO messages (conversationId, workspaceId, role, content, createdAt) VALUES (1, 1, ${role}, 'synthetic', FROM_UNIXTIME(${Date.parse(at) / 1000}))`);
    }
    await e.execute(sql`INSERT INTO projects (workspaceId, name, createdAt) VALUES (1, 'p', FROM_UNIXTIME(${Date.parse("2026-10-21T12:00:00Z") / 1000}))`);
    await e.execute(sql`INSERT INTO documents (workspaceId, filename, mimeType, extractedText, contentHash, createdAt) VALUES (1, 'secret-name.pdf', 'application/pdf', 'x', ${"a".repeat(64)}, FROM_UNIXTIME(${Date.parse("2026-10-20T12:00:00Z") / 1000}))`);
  }

  it("aggregates model, creator and activity per UTC day inside the range only, with outcomes per provider and model", async () => {
    await seed();
    const l = await buildValueLedger(db(), { from: "2026-10-20", to: "2026-10-21" }, persisted);
    expect(l.range).toEqual({ from: "2026-10-20", to: "2026-10-21", days: 2, timezone: "UTC" });
    expect(l.model.usageRecording).toBe("persisted");
    expect(l.model.totals).toEqual({ requests: 6, tokens: 4500, cost: 0.19, estimatedCommits: 1 });
    expect(l.daily.map(d => d.model?.requests)).toEqual([4, 2]);
    expect(l.model.providers.sort((a, b) => a.providerId.localeCompare(b.providerId))).toEqual([
      { providerId: "external", committed: 2, released: 1, held: 0, releasedShare: 0.333333 },
      { providerId: "local", committed: 1, released: 0, held: 1, releasedShare: 0 },
    ]);
    expect(l.activity.totals).toEqual({ userMessages: 2, assistantMessages: 3, conversations: 2, documents: 1, projects: 1 });
    expect(l.daily.map(d => d.activity.assistantMessages)).toEqual([1, 2]);
    expect(l.model.costPerAssistantMessage).toBe(0.063333);
    expect(l.creator.totals).toEqual({ generations: 2, cost: 1.5 });
    expect(l.creator.models.find(m => m.model === "vid-model")).toMatchObject({ kind: "video", committed: 1, released: 1, committedCost: 1, releasedShare: 0.5 });
    expect(l.quality.status).toBe("NOT_MEASURED");
    // aggregates only: no file names, message text or identities
    expect(JSON.stringify(l)).not.toMatch(/secret-name|synthetic|"userId"/);
  });

  it("does not present unpersisted model usage as zero usage, and never mixes cost units", async () => {
    await seed();
    const l = await buildValueLedger(db(), { from: "2026-10-20", to: "2026-10-21" }, {});
    expect(l.model).toMatchObject({ usageRecording: "not_persisted", totals: null, costUnit: null, costPerAssistantMessage: null });
    expect(l.daily.every(d => d.model === null)).toBe(true);
    expect(l.creator.totals.cost).toBe(1.5);
  });

  it("UTC day buckets do not depend on the session time zone", async () => {
    await seed();
    await database.db.execute(sql`SET time_zone = '+05:30'`);
    try {
      const l = await buildValueLedger(db(), { from: "2026-10-20", to: "2026-10-21" }, persisted);
      expect(l.activity.totals).toEqual({ userMessages: 2, assistantMessages: 3, conversations: 2, documents: 1, projects: 1 });
      expect(l.daily.map(d => d.activity.conversations)).toEqual([1, 1]);
    } finally {
      await database.db.execute(sql`SET time_zone = '+00:00'`);
    }
  });

  it("an empty range returns zero-filled days, not missing ones", async () => {
    const l = await buildValueLedger(db(), { from: "2026-01-01", to: "2026-01-03" }, persisted);
    expect(l.daily.map(d => d.day)).toEqual(["2026-01-01", "2026-01-02", "2026-01-03"]);
    expect(l.model.totals).toEqual({ requests: 0, tokens: 0, cost: 0, estimatedCommits: 0 });
    expect(l.model.costPerAssistantMessage).toBeNull();
  });
});
