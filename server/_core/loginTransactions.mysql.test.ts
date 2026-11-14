import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { createTestDatabase, skipMysqlSuite, type TestDatabase } from "../testing/mysqlTestDb";
import { MysqlLoginTransactionStore, newLoginNonce } from "./loginTransactions";

const challengeOf = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");
const fresh = () => ({ nonce: newLoginNonce(), challenge: challengeOf(randomBytes(32).toString("base64url")) });

describe.skipIf(skipMysqlSuite())("oauth login transactions on real SQL", () => {
  let database: TestDatabase;
  let instanceA: MysqlLoginTransactionStore; let instanceB: MysqlLoginTransactionStore;
  const rows = async () => ((await database.db.execute(sql`SELECT nonceHash, challengeHash, consumedAt, expiresAt FROM oauthLoginTransactions`)) as unknown as [any[]])[0];

  beforeAll(async () => {
    database = await createTestDatabase();
    instanceA = new MysqlLoginTransactionStore(async () => database.db);
    instanceB = new MysqlLoginTransactionStore(async () => database.db);
  });
  afterAll(async () => { await database?.close(); });

  it("normal flow: begin on one instance, consume exactly once on another", async () => {
    const t = fresh();
    await instanceA.begin(t.nonce, t.challenge);
    expect(await instanceB.consume(t.nonce, t.challenge)).toBe(true);
    expect(await instanceA.consume(t.nonce, t.challenge)).toBe(false); // replay after success, either instance
    expect(await instanceB.consume(t.nonce, t.challenge)).toBe(false);
  });

  it("stores only digests: neither the nonce nor the challenge appears in the table", async () => {
    const t = fresh();
    await instanceA.begin(t.nonce, t.challenge);
    const all = JSON.stringify(await rows());
    expect(all).not.toContain(t.nonce); expect(all).not.toContain(t.challenge);
  });

  it("concurrent double consume across two instances: exactly one winner out of 40", async () => {
    const t = fresh();
    await instanceA.begin(t.nonce, t.challenge);
    const results = await Promise.all(Array.from({ length: 40 }, (_, i) => (i % 2 ? instanceA : instanceB).consume(t.nonce, t.challenge)));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("a callback cannot consume another transaction: wrong nonce / wrong PKCE challenge leave the real one intact", async () => {
    const mine = fresh(); const other = fresh();
    await instanceA.begin(mine.nonce, mine.challenge); await instanceA.begin(other.nonce, other.challenge);
    expect(await instanceB.consume(mine.nonce, other.challenge)).toBe(false); // right nonce, someone else's challenge
    expect(await instanceB.consume(newLoginNonce(), mine.challenge)).toBe(false); // unknown nonce
    expect(await instanceB.consume(mine.nonce, mine.challenge)).toBe(true); // still valid afterwards
    expect(await instanceB.consume(other.nonce, other.challenge)).toBe(true);
  });

  it("expired transactions cannot be consumed (database clock)", async () => {
    const t = fresh();
    await instanceA.begin(t.nonce, t.challenge);
    await database.db.execute(sql`UPDATE oauthLoginTransactions SET expiresAt = DATE_SUB(NOW(3), INTERVAL 1 SECOND) WHERE nonceHash = ${createHash("sha256").update(t.nonce).digest("hex")}`);
    expect(await instanceB.consume(t.nonce, t.challenge)).toBe(false);
  });

  it("malformed input is refused without a database round trip being able to succeed", async () => {
    expect(await instanceA.consume("short", "short")).toBe(false);
    expect(await instanceA.consume(newLoginNonce(), "not-base64url-challenge!!!!!!!!!!!!!!!!!!!!!!!!!")).toBe(false);
    await expect(instanceA.begin("short", "short")).rejects.toThrow(/malformed/);
  });

  it("database unavailable: begin/consume/cleanup throw (callers fail closed), never resolve true", async () => {
    const down = new MysqlLoginTransactionStore(async () => null);
    const t = fresh();
    await expect(down.begin(t.nonce, t.challenge)).rejects.toThrow(/unavailable/);
    await expect(down.consume(t.nonce, t.challenge)).rejects.toThrow(/unavailable/);
    await expect(down.cleanup()).rejects.toThrow(/unavailable/);
  });

  it("cleanup removes only long-expired rows and never a live or recently expired transaction", async () => {
    const live = fresh(); const recent = fresh(); const old = fresh(); const oldConsumed = fresh();
    for (const t of [live, recent, old, oldConsumed]) await instanceA.begin(t.nonce, t.challenge);
    const h = (n: string) => createHash("sha256").update(n).digest("hex");
    await database.db.execute(sql`UPDATE oauthLoginTransactions SET expiresAt = DATE_SUB(NOW(3), INTERVAL 5 SECOND) WHERE nonceHash = ${h(recent.nonce)}`);
    await database.db.execute(sql`UPDATE oauthLoginTransactions SET expiresAt = DATE_SUB(NOW(3), INTERVAL 1 HOUR) WHERE nonceHash IN (${h(old.nonce)}, ${h(oldConsumed.nonce)})`);
    await database.db.execute(sql`UPDATE oauthLoginTransactions SET consumedAt = NOW(3) WHERE nonceHash = ${h(oldConsumed.nonce)}`);
    expect(await instanceA.cleanup(60)).toBeGreaterThanOrEqual(2);
    const left = new Set((await rows()).map(r => r.nonceHash));
    expect(left.has(h(live.nonce))).toBe(true);
    expect(left.has(h(recent.nonce))).toBe(true);
    expect(left.has(h(old.nonce))).toBe(false);
    expect(left.has(h(oldConsumed.nonce))).toBe(false);
    expect(await instanceB.consume(live.nonce, live.challenge)).toBe(true); // a live transaction survived cleanup
  });
});
