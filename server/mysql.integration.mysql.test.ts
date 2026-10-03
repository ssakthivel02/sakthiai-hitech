import net from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { getTableConfig, MySqlTable } from "drizzle-orm/mysql-core";
import { is } from "drizzle-orm";
import type { Request } from "express";
import { createTestDatabase, migrationStatements, skipMysqlSuite, type TestDatabase } from "./testing/mysqlTestDb";

/**
 * Real-SQL qualification of the application's persistence-facing behaviour: migrations vs schema, session
 * revocation, workspace membership, tenant isolation (tRPC), safe upload through a real scanner protocol
 * (an in-process clamd INSTREAM server), storage ownership, retrieval/grounding, provider-policy persistence
 * and readiness. The ONLY substitutes are object storage (put is faked) and the model transport (stub adapter).
 * Runs against whatever TEST_DATABASE_URL points at (local MariaDB here; the CI job uses a MySQL 8 service).
 */
const storageState = vi.hoisted(() => ({ puts: [] as string[] }));
vi.mock("./storage", () => ({
  storagePut: vi.fn(async (relKey: string) => { const key = `${relKey}-${storageState.puts.length}abcd`; storageState.puts.push(key); return { key, url: `/storage/${key}` }; }),
}));
vi.mock("./creator/router", async () => {
  const { router } = await import("./_core/trpc");
  return { creatorRouter: router({}) };
});

type AnyFn = (...args: any[]) => any;
const TAMIL_TXT = "முருகன் கோவில் பழநியில் உள்ளது. The Murugan temple opens at 6am.\nவழிபாடு காலை ஆறு மணிக்கு தொடங்கும்.";

function startFakeClamd() {
  const server = net.createServer(socket => {
    let buffer = Buffer.alloc(0);
    socket.on("data", chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      const header = Buffer.from("zINSTREAM\0");
      if (buffer.length < header.length || !buffer.subarray(0, header.length).equals(header)) return;
      let offset = header.length;
      const parts: Buffer[] = [];
      while (buffer.length >= offset + 4) {
        const length = buffer.readUInt32BE(offset);
        offset += 4;
        if (length === 0) {
          const content = Buffer.concat(parts).toString("utf8");
          socket.write(content.includes("EICAR-STANDARD-ANTIVIRUS-TEST-FILE") ? "stream: Eicar-Test-Signature FOUND\0" : "stream: OK\0");
          return;
        }
        if (buffer.length < offset + length) return;
        parts.push(buffer.subarray(offset, offset + length));
        offset += length;
      }
    });
    socket.on("error", () => undefined);
  });
  return new Promise<{ server: net.Server; port: number }>(resolve => server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as net.AddressInfo).port })));
}

describe.skipIf(skipMysqlSuite())("application on real SQL", () => {
  let database: TestDatabase;
  let clamd: Awaited<ReturnType<typeof startFakeClamd>>;
  let m: { db: typeof import("./db"); sdk: typeof import("./_core/sdk")["sdk"]; routers: typeof import("./routers"); access: typeof import("./storageAccess"); readiness: typeof import("./_core/readiness"); gateway: typeof import("./gateway"); revocation: typeof import("./_core/sessionRevocation"); schema: typeof import("../drizzle/schema"); mysqlMod: typeof import("./_core/mysql") };
  let userA: any, userB: any, wsA: number, wsB: number;

  const callerFor = (user: any) => m.routers.appRouter.createCaller({ user, req: { protocol: "https", headers: {} } as Request, res: { headersSent: false, setHeader: () => undefined, clearCookie: () => undefined } as any, requestId: "it" } as any);
  const rows = async <T = Record<string, any>>(query: ReturnType<typeof sql>) => ((await database.db.execute(query)) as unknown as [T[]])[0];
  const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

  beforeAll(async () => {
    database = await createTestDatabase();
    clamd = await startFakeClamd();
    Object.assign(process.env, { DATABASE_URL: database.url, DATABASE_EXPECTED_NAME: database.name, JWT_SECRET: "integration-test-secret-not-real-0123456789", VITE_APP_ID: "sakthiai-it", MALWARE_SCANNER_HOST: "127.0.0.1", MALWARE_SCANNER_PORT: String(clamd.port), MALWARE_SCANNER_TIMEOUT_MS: "2000" });
    for (const key of ["LLM_API_URL", "LOCAL_LLM_API_URL", "EMBEDDING_API_URL", "LOCAL_EMBEDDING_API_URL", "GATEWAY_ALLOW_EXTERNAL"]) delete process.env[key];
    m = {
      db: await import("./db"), sdk: (await import("./_core/sdk")).sdk, routers: await import("./routers"), access: await import("./storageAccess"),
      readiness: await import("./_core/readiness"), gateway: await import("./gateway"), revocation: await import("./_core/sessionRevocation"), schema: await import("../drizzle/schema"), mysqlMod: await import("./_core/mysql"),
    };
    await m.db.upsertUser({ openId: "it-user-a", name: "Alice", email: "a@example.test", loginMethod: "test" });
    await m.db.upsertUser({ openId: "it-user-b", name: "Bhavya", email: "b@example.test", loginMethod: "test" });
    userA = await m.db.getUserByOpenId("it-user-a");
    userB = await m.db.getUserByOpenId("it-user-b");
    wsA = (await m.db.ensureWorkspace(userA)).id;
    wsB = (await m.db.ensureWorkspace(userB)).id;
  });
  afterAll(async () => { clamd?.server.close(); m?.gateway.setProviderGatewayForTests(null); await database?.close(); });

  describe("migrations", () => {
    it("every journal entry has a SQL file and the migrated schema matches drizzle/schema.ts (tables and columns)", async () => {
      expect(migrationStatements().length).toBeGreaterThanOrEqual(7);
      const have = await rows<{ t: string; c: string }>(sql`SELECT TABLE_NAME t, COLUMN_NAME c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ${database.name}`);
      const columns = new Map<string, Set<string>>();
      for (const row of have) (columns.get(row.t) ?? columns.set(row.t, new Set()).get(row.t)!).add(row.c);
      let checked = 0;
      for (const value of Object.values(m.schema)) {
        if (!is(value, MySqlTable)) continue;
        const config = getTableConfig(value);
        const actual = columns.get(config.name);
        expect(actual, `table ${config.name} missing after migrations`).toBeDefined();
        for (const column of config.columns) expect(actual!.has(column.name), `${config.name}.${column.name}`).toBe(true);
        checked += 1;
      }
      expect(checked).toBeGreaterThanOrEqual(20);
    });
  });

  describe("session revocation (real users table)", () => {
    const cookieFor = (token: string) => ({ headers: { cookie: `app_session_id=${token}` } }) as unknown as Request;
    it("login generation authenticates; revoke-all invalidates every older token; a new login works; futures are rejected", async () => {
      const gen1 = m.revocation.sessionGenerationFromDate(await m.db.advanceUserSessionGeneration("it-user-a"))!;
      const t1 = await m.sdk.createSessionToken("it-user-a", { name: "A", sessionGeneration: gen1 });
      expect((await m.sdk.authenticateRequest(cookieFor(t1))).openId).toBe("it-user-a");
      await m.sdk.revokeAllSessions("it-user-a");
      await expect(m.sdk.authenticateRequest(cookieFor(t1))).rejects.toThrow(/revoked/i);
      const gen2 = m.revocation.sessionGenerationFromDate(await m.db.advanceUserSessionGeneration("it-user-a"))!;
      expect(gen2).toBeGreaterThan(gen1);
      const t2 = await m.sdk.createSessionToken("it-user-a", { name: "A", sessionGeneration: gen2 });
      expect((await m.sdk.authenticateRequest(cookieFor(t2))).openId).toBe("it-user-a");
      await expect(m.sdk.authenticateRequest(cookieFor(t1))).rejects.toThrow();
      const future = await m.sdk.createSessionToken("it-user-a", { name: "A", sessionGeneration: gen2 + 100 });
      await expect(m.sdk.authenticateRequest(cookieFor(future))).rejects.toThrow();
      // another user's session is unaffected by A's revocation
      const genB = m.revocation.sessionGenerationFromDate(await m.db.advanceUserSessionGeneration("it-user-b"))!;
      const tb = await m.sdk.createSessionToken("it-user-b", { name: "B", sessionGeneration: genB });
      await m.sdk.revokeAllSessions("it-user-a");
      expect((await m.sdk.authenticateRequest(cookieFor(tb))).openId).toBe("it-user-b");
    });

    it("concurrent security events never move the generation backwards and always advance it", async () => {
      const before = m.revocation.sessionGenerationFromDate((await m.db.getUserByOpenId("it-user-a"))!.lastSignedIn)!;
      const seen = await Promise.all(Array.from({ length: 12 }, () => m.db.advanceUserSessionGeneration("it-user-a")));
      const after = m.revocation.sessionGenerationFromDate((await m.db.getUserByOpenId("it-user-a"))!.lastSignedIn)!;
      expect(after).toBeGreaterThanOrEqual(before + 12); // each event advanced it at least once
      for (const date of seen) expect(m.revocation.sessionGenerationFromDate(date)!).toBeGreaterThan(before);
    });

    it("a login upsert never moves the persisted generation backwards (a revoked token cannot become current again)", async () => {
      // Generation runs ahead of the wall clock after bursts of security events; simulate that state exactly.
      await database.db.execute(sql`UPDATE users SET lastSignedIn = DATE_ADD(NOW(), INTERVAL 1 HOUR) WHERE openId = 'it-user-b'`);
      const gen = m.revocation.sessionGenerationFromDate((await m.db.getUserByOpenId("it-user-b"))!.lastSignedIn)!;
      const token = await m.sdk.createSessionToken("it-user-b", { name: "B", sessionGeneration: gen });
      expect((await m.sdk.authenticateRequest(cookieFor(token))).openId).toBe("it-user-b");
      await m.sdk.revokeAllSessions("it-user-b");
      const revokedAt = (await m.db.getUserByOpenId("it-user-b"))!.lastSignedIn;
      await m.db.upsertUser({ openId: "it-user-b", name: "Bhavya", email: "b@example.test", loginMethod: "test" });
      const afterUpsert = (await m.db.getUserByOpenId("it-user-b"))!.lastSignedIn;
      expect(afterUpsert.getTime()).toBeGreaterThanOrEqual(revokedAt.getTime());
      await expect(m.sdk.authenticateRequest(cookieFor(token))).rejects.toThrow();
    });
  });

  describe("workspace membership and tenant isolation (tRPC on real SQL)", () => {
    it("ensureWorkspace is idempotent per user even under concurrency", async () => {
      await m.db.upsertUser({ openId: "it-user-c", name: "Chitra", loginMethod: "test" });
      const c = (await m.db.getUserByOpenId("it-user-c"))!;
      const created = await Promise.all(Array.from({ length: 6 }, () => m.db.ensureWorkspace(c)));
      expect(new Set(created.map(w => w.id)).size).toBe(1);
      const [count] = await rows<{ n: number }>(sql`SELECT COUNT(*) n FROM workspaceMembers WHERE userId = ${c.id}`);
      expect(Number(count.n)).toBe(1);
    });

    it("membership matrix: members resolve, strangers do not, lists never include foreign workspaces", async () => {
      expect(await m.db.getWorkspaceForUser(userA.id, wsA)).toMatchObject({ id: wsA });
      expect(await m.db.getWorkspaceForUser(userA.id, wsB)).toBeUndefined();
      expect(await m.db.getWorkspaceForUser(userB.id, wsA)).toBeUndefined();
      expect((await m.db.listUserWorkspaces(userA.id)).map(r => r.workspace.id)).toEqual([wsA]);
      expect((await m.db.listUserWorkspaces(userB.id)).map(r => r.workspace.id)).toEqual([wsB]);
      expect(await m.db.getWorkspaceForUser(userA.id, 999999)).toBeUndefined();
    });

    it("projects/files/chat reject non-members and keep data inside the workspace", async () => {
      const a = callerFor(userA); const b = callerFor(userB);
      await a.projects.create({ workspaceId: wsA, name: "Alice project" });
      await b.projects.create({ workspaceId: wsB, name: "Bhavya project" });
      expect((await a.projects.list({ workspaceId: wsA })).map(p => p.name)).toEqual(["Alice project"]);
      expect((await b.projects.list({ workspaceId: wsB })).map(p => p.name)).toEqual(["Bhavya project"]);
      await expect(b.projects.list({ workspaceId: wsA })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(b.projects.create({ workspaceId: wsA, name: "intrusion" })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(b.files.list({ workspaceId: wsA })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(b.chat.send({ workspaceId: wsA, message: "hello there" })).rejects.toMatchObject({ code: "FORBIDDEN" });
      const [leak] = await rows<{ n: number }>(sql`SELECT COUNT(*) n FROM projects WHERE name = 'intrusion'`);
      expect(Number(leak.n)).toBe(0);
    });

    it("a workspace member cannot read or continue another member's conversation", async () => {
      await database.db.insert(m.schema.workspaceMembers).values({ workspaceId: wsA, userId: userB.id, role: "member" });
      const a = callerFor(userA); const b = callerFor(userB);
      const mine = await a.chat.send({ workspaceId: wsA, message: "private note about reservoirs" });
      await expect(b.chat.history({ workspaceId: wsA, conversationId: mine.conversationId })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(b.chat.send({ workspaceId: wsA, conversationId: mine.conversationId, message: "continue" })).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect((await a.chat.history({ workspaceId: wsA, conversationId: mine.conversationId })).length).toBeGreaterThan(0);
      await database.db.execute(sql`DELETE FROM workspaceMembers WHERE workspaceId = ${wsA} AND userId = ${userB.id}`);
      await expect(b.projects.list({ workspaceId: wsA })).rejects.toMatchObject({ code: "FORBIDDEN" }); // removal takes effect immediately
    });
  });

  describe("durable tasks through tRPC (workspace ownership)", () => {
    it("members see and cancel only their own workspace's tasks; foreign workspaces are FORBIDDEN and foreign task ids are NOT_FOUND", async () => {
      const { MysqlTaskStore } = await import("./tasks");
      const store = new MysqlTaskStore(m.db.getDb as never);
      const { task } = await store.create({ workspaceId: wsA, type: "it.task", input: { n: 1 } });
      const a = callerFor(userA); const b = callerFor(userB);
      expect(await a.tasks.get({ workspaceId: wsA, taskId: task.id })).toMatchObject({ id: task.id, state: "QUEUED", type: "it.task" });
      expect(JSON.stringify(await a.tasks.get({ workspaceId: wsA, taskId: task.id }))).not.toMatch(/leaseOwner|inputJson/);
      expect((await a.tasks.list({ workspaceId: wsA })).map(t => t.id)).toContain(task.id);
      await expect(b.tasks.get({ workspaceId: wsA, taskId: task.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(b.tasks.list({ workspaceId: wsA })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(b.tasks.cancel({ workspaceId: wsA, taskId: task.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
      // B names its OWN workspace but A's task id: indistinguishable from absent, and nothing changes
      await expect(b.tasks.get({ workspaceId: wsB, taskId: task.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(b.tasks.cancel({ workspaceId: wsB, taskId: task.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect((await a.tasks.get({ workspaceId: wsA, taskId: task.id })).state).toBe("QUEUED");
      expect((await a.tasks.cancel({ workspaceId: wsA, taskId: task.id })).state).toBe("CANCELLED");
    });
  });

  describe("safe upload (real scanner protocol), storage ownership", () => {
    it("clean upload persists document + chunks with searchText inside the workspace only", async () => {
      const a = callerFor(userA);
      const result = await a.files.upload({ workspaceId: wsA, filename: "temples.txt", mimeType: "text/plain", dataBase64: b64(TAMIL_TXT) });
      expect(result).toMatchObject({ filename: "temples.txt", scanner: "clean" });
      const chunks = await rows<{ workspaceId: number; searchText: string | null }>(sql`SELECT workspaceId, searchText FROM documentChunks WHERE documentId = ${result.id}`);
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks.every(c => c.workspaceId === wsA && c.searchText && c.searchText.length > 0)).toBe(true);
      await expect(a.files.upload({ workspaceId: wsA, filename: "temples-again.txt", mimeType: "text/plain", dataBase64: b64(TAMIL_TXT) })).rejects.toMatchObject({ code: "CONFLICT" });
      await expect(callerFor(userB).files.upload({ workspaceId: wsA, filename: "x.txt", mimeType: "text/plain", dataBase64: b64("intrusion text") })).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("an infected file is quarantined and nothing is stored or persisted; an unavailable scanner fails closed", async () => {
      const a = callerFor(userA);
      const before = storageState.puts.length;
      const [docsBefore] = await rows<{ n: number }>(sql`SELECT COUNT(*) n FROM documents`);
      await expect(a.files.upload({ workspaceId: wsA, filename: "eicar.txt", mimeType: "text/plain", dataBase64: b64("X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*") })).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringMatching(/quarantined/i) });
      process.env.MALWARE_SCANNER_PORT = "1"; // nothing listens there
      await expect(a.files.upload({ workspaceId: wsA, filename: "new.txt", mimeType: "text/plain", dataBase64: b64("fresh content for the scanner outage") })).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
      process.env.MALWARE_SCANNER_PORT = String(clamd.port);
      const [docsAfter] = await rows<{ n: number }>(sql`SELECT COUNT(*) n FROM documents`);
      expect(Number(docsAfter.n)).toBe(Number(docsBefore.n));
      expect(storageState.puts.length).toBe(before);
    });

    it("object access follows workspace membership exactly (documents and creator assets), binary-exact", async () => {
      const [doc] = await rows<{ storageKey: string }>(sql`SELECT storageKey FROM documents WHERE workspaceId = ${wsA} AND filename = 'temples.txt'`);
      const deps = { findOwners: m.db.findStorageObjectOwners, getWorkspaceForUser: m.db.getWorkspaceForUser };
      expect(await m.access.resolveAuthorizedStorageKey(userA, doc.storageKey, deps)).toBe(doc.storageKey);
      expect(await m.access.resolveAuthorizedStorageKey(userB, doc.storageKey, deps)).toBeNull();
      expect(await m.access.resolveAuthorizedStorageKey(userA, doc.storageKey.toUpperCase(), deps)).toBeNull(); // case-insensitive SQL match must not authorise
      expect(await m.access.resolveAuthorizedStorageKey(userA, "does/not/exist", deps)).toBeNull();
      expect(await m.access.resolveAuthorizedStorageKey(userA, "../etc/passwd", deps)).toBeNull();
      // creator asset owned by workspace B
      await database.db.execute(sql`INSERT INTO creatorProjects (workspaceId, userId, title, brief, status) VALUES (${wsB}, ${userB.id}, 't', 'b', 'DRAFT')`).catch(() => undefined);
      const [project] = await rows<{ id: number }>(sql`SELECT id FROM creatorProjects WHERE workspaceId = ${wsB} LIMIT 1`).catch(() => [] as Array<{ id: number }>);
      if (project) {
        await database.db.insert(m.schema.creatorAssets).values({ workspaceId: wsB, creatorProjectId: project.id, assetType: "IMAGE", mimeType: "image/png", storageKey: "b/assets/pic.png", checksumSha256: "0".repeat(64), provenanceJson: "{}" });
        expect(await m.access.resolveAuthorizedStorageKey(userB, "b/assets/pic.png", deps)).toBe("b/assets/pic.png");
        expect(await m.access.resolveAuthorizedStorageKey(userA, "b/assets/pic.png", deps)).toBeNull();
      }
    });
  });

  describe("retrieval, grounding and provider policy on real SQL", () => {
    const stubGateway = (reply: string | null) => {
      const config = m.gateway.loadGatewayConfig({ LOCAL_LLM_API_URL: "http://local.it.invalid", LOCAL_LLM_MODEL: "it-model" });
      const gw = m.gateway.createProviderGateway(config, { log: () => undefined, adapterFactory: binding => ({ providerId: binding.providerId, complete: async () => { if (reply === null) throw new m.gateway.ProviderCallError("server_error", 503); return { content: reply, finishReason: "stop", usage: null, attempts: 1 }; } }) });
      m.gateway.setProviderGatewayForTests(gw);
    };

    it("English, Tamil and mixed queries ground on the uploader's workspace only; the other tenant gets INSUFFICIENT_EVIDENCE", async () => {
      stubGateway("It opens at 6am. [1]");
      const a = callerFor(userA); const b = callerFor(userB);
      const english = await a.chat.send({ workspaceId: wsA, message: "Murugan temple opens at what time" });
      expect(english).toMatchObject({ grounding: "GROUNDED_EVIDENCE" });
      expect(english.citations.every(c => c.filename === "temples.txt")).toBe(true);
      const tamil = await a.chat.send({ workspaceId: wsA, message: "முருகன் கோவில் எங்கு உள்ளது", language: "ta" });
      expect(tamil.grounding).toBe("GROUNDED_EVIDENCE");
      const mixed = await a.chat.send({ workspaceId: wsA, message: "முருகன் temple 6am" });
      expect(mixed.grounding).toBe("GROUNDED_EVIDENCE");
      for (const message of ["Murugan temple opens at what time", "முருகன் கோவில் எங்கு உள்ளது"]) {
        const foreign = await b.chat.send({ workspaceId: wsB, message });
        expect(foreign).toMatchObject({ grounding: "INSUFFICIENT_EVIDENCE", citations: [] });
      }
      const none = await a.chat.send({ workspaceId: wsA, message: "quantum chromodynamics lattice" });
      expect(none.grounding).toBe("INSUFFICIENT_EVIDENCE");
      const [persisted] = await rows<{ n: number }>(sql`SELECT COUNT(*) n FROM messages WHERE conversationId = ${english.conversationId} AND workspaceId = ${wsA}`);
      expect(Number(persisted.n)).toBe(2);
    });

    it("provider outage is MODEL_UNAVAILABLE with evidence preserved (never a fabricated answer)", async () => {
      stubGateway(null);
      const result = await callerFor(userA).chat.send({ workspaceId: wsA, message: "Murugan temple opens at what time" });
      expect(result.grounding).toBe("MODEL_UNAVAILABLE");
      expect(result.citations.length).toBeGreaterThan(0);
      expect(result.answer).not.toMatch(/6am/);
    });

    it("GATEWAY_STATE_STORE=mysql persists policy and budget through the application's own connection", async () => {
      const env = { LLM_API_URL: "https://external.it.invalid", LLM_MODEL: "m", GATEWAY_ALLOW_EXTERNAL: "true", GATEWAY_ALLOW_METERED: "true", GATEWAY_STATE_STORE: "mysql", GATEWAY_MAX_OUTPUT_TOKENS: "10" };
      const gw = m.gateway.buildGatewayFromEnv(env, { log: () => undefined, adapterFactory: binding => ({ providerId: binding.providerId, complete: async () => ({ content: "ok", finishReason: "stop", usage: { totalTokens: 20 }, attempts: 1 }) }) });
      const call = () => gw.invoke({ requestId: "r", workspaceId: wsA, messages: [{ role: "user", content: "hi" }] });
      expect((await call()).status).toBe("failed"); // no policy row => external denied
      await m.gateway.upsertWorkspaceProviderPolicy(m.db.getDb as never, wsA, { externalEnabled: true, meteredEnabled: true, maxRequestsPerDay: 1 });
      expect((await call()).status).toBe("returned");
      expect(await call()).toMatchObject({ status: "failed", reason: "budget_denied" });
      const [usage] = await rows<{ requests: number; tokens: number }>(sql`SELECT requests, tokens FROM providerUsageWindows WHERE workspaceId = ${wsA}`);
      expect([Number(usage.requests), Number(usage.tokens)]).toEqual([1, 20]);
      expect((await rows(sql`SELECT * FROM providerUsageWindows WHERE workspaceId = ${wsB}`)).length).toBe(0);
    });
  });

  describe("readiness", () => {
    it("probe is true on a live database and false when the probe fails; bad credentials / wrong database never connect", async () => {
      expect(await m.readiness.probeDatabaseReadiness()).toBe(true);
      expect(await m.readiness.probeDatabaseReadiness(async () => { throw new Error("db down"); })).toBe(false);
      const url = new URL(database.url);
      const wrongPassword = `mysql://${url.username}:definitely-wrong@${url.host}/${database.name}`;
      await expect(m.mysqlMod.createVerifiedMysqlPool(wrongPassword)).rejects.toThrow();
      await expect(m.mysqlMod.createVerifiedMysqlPool(database.url, "some_other_database")).rejects.toThrow(/must target/);
      const ok = await m.mysqlMod.createVerifiedMysqlPool(database.url, database.name);
      await ok.promise().end();
    });
  });
});
