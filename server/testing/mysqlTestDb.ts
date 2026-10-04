import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import mysql, { type Pool } from "mysql2";
import { drizzle } from "drizzle-orm/mysql2";

/**
 * Real-MySQL test harness. Never touches a database it did not create: it connects with
 * TEST_DATABASE_URL (server-level credentials, any database name), creates a uniquely named throwaway
 * database, applies every migration in drizzle/meta/_journal.json order, and drops it afterwards.
 * Refuses any host that looks like a managed/production service.
 */
export const mysqlTestUrl = () => process.env.TEST_DATABASE_URL?.trim() || "";
export const mysqlRequired = () => process.env.MYSQL_REQUIRED === "1";
/** For `describe.skipIf`: skip only when MySQL is optional AND absent. With MYSQL_REQUIRED=1 absence is a failure. */
export const skipMysqlSuite = () => !mysqlTestUrl() && !mysqlRequired();

export type TestDatabase = { pool: Pool; db: ReturnType<typeof drizzle>; name: string; url: string; close(): Promise<void> };

export function assertSafeTarget(url: URL) {
  if (url.protocol !== "mysql:") throw new Error("TEST_DATABASE_URL must use mysql://");
  if (/aivencloud\.com$|\.render\.com$|\.rds\.amazonaws\.com$|\.database\.azure\.com$/i.test(url.hostname)) {
    throw new Error("refusing to run integration tests against a managed database host");
  }
  if (!["127.0.0.1", "localhost", "::1", "mysql", "db"].includes(url.hostname) && process.env.MYSQL_TEST_ALLOW_REMOTE !== "1") {
    throw new Error(`TEST_DATABASE_URL host ${url.hostname} is not loopback; set MYSQL_TEST_ALLOW_REMOTE=1 only for a disposable server`);
  }
}

export function migrationStatements(root = process.cwd()): Array<{ tag: string; statements: string[] }> {
  const journal = JSON.parse(readFileSync(path.join(root, "drizzle/meta/_journal.json"), "utf8")) as { entries: Array<{ tag: string }> };
  return journal.entries.map(entry => ({
    tag: entry.tag,
    statements: readFileSync(path.join(root, "drizzle", `${entry.tag}.sql`), "utf8").split("--> statement-breakpoint").map(part => part.trim()).filter(Boolean),
  }));
}

export async function createTestDatabase(options: { migrate?: boolean } = {}): Promise<TestDatabase> {
  const raw = mysqlTestUrl();
  if (!raw) throw new Error("TEST_DATABASE_URL is required (MYSQL_REQUIRED=1 forbids skipping)");
  const base = new URL(raw);
  assertSafeTarget(base);
  const name = `sakthi_it_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
  const admin = mysql.createConnection({ host: base.hostname, port: base.port ? Number(base.port) : 3306, user: decodeURIComponent(base.username), password: decodeURIComponent(base.password), multipleStatements: false }).promise();
  await admin.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await admin.end();

  const pool = mysql.createPool({ host: base.hostname, port: base.port ? Number(base.port) : 3306, user: decodeURIComponent(base.username), password: decodeURIComponent(base.password), database: name, connectionLimit: 20, waitForConnections: true });
  if (options.migrate !== false) {
    for (const migration of migrationStatements()) for (const statement of migration.statements) await pool.promise().query(statement);
  }
  return {
    pool,
    db: drizzle(pool),
    name,
    url: `mysql://${encodeURIComponent(decodeURIComponent(base.username))}:${encodeURIComponent(decodeURIComponent(base.password))}@${base.hostname}:${base.port || 3306}/${name}`,
    async close() {
      await pool.promise().end().catch(() => undefined);
      const dropper = mysql.createConnection({ host: base.hostname, port: base.port ? Number(base.port) : 3306, user: decodeURIComponent(base.username), password: decodeURIComponent(base.password) }).promise();
      await dropper.query(`DROP DATABASE IF EXISTS \`${name}\``);
      await dropper.end();
    },
  };
}
