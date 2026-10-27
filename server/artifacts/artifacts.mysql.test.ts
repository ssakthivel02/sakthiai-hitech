import net from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import type { Request } from "express";
import { createTestDatabase, skipMysqlSuite, type TestDatabase } from "../testing/mysqlTestDb";
import { modelUnavailableMessage } from "../grounding";
import { searchTextFor } from "../retrievalStore";

/**
 * Real-SQL proof of the artifacts + workspace-search journey through the REAL appRouter:
 *   files.upload -> chat.send (grounded) -> artifacts.saveFromMessage -> artifacts.list/get -> search.workspace
 * and of the security properties that matter: tenant isolation, ownership, no client-forged evidence, idempotency under
 * a race, refusal of non-answers, and DB-side candidate selection that is not "newest N rows".
 * Substitutes: object storage (put is faked), malware scanner (in-process clamd protocol server), model transport (stub).
 */
vi.mock("../storage", () => ({ storagePut: vi.fn(async (relKey: string) => ({ key: `${relKey}-stored`, url: `/storage/${relKey}` })) }));
vi.mock("../creator/router", async () => {
  const { router } = await import("../_core/trpc");
  return { creatorRouter: router({}) };
});

const RLO = String.fromCharCode(0x202e);
const TEMPLES_TXT = "முருகன் கோவில் பழநியில் உள்ளது. The Murugan temple opens at 6am.\nவழிபாடு காலை ஆறு மணிக்கு தொடங்கும்.";
const TAMIL_REPLY = "முருகன் கோவில் காலை ஆறு மணிக்கு திறக்கும். [1]";
const B_SECRET_TXT = "TENANT-B-ONLY-MARKER zephyrbudget confidential figures for workspace B only";

function startFakeClamd() {
  const server = net.createServer(socket => {
    let buffer = Buffer.alloc(0);
    socket.on("data", chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      const header = Buffer.from("zINSTREAM\0");
      if (buffer.length < header.length || !buffer.subarray(0, header.length).equals(header)) return;
      let offset = header.length;
      while (buffer.length >= offset + 4) {
        const length = buffer.readUInt32BE(offset);
        offset += 4;
        if (length === 0) { socket.write("stream: OK\0"); return; }
        if (buffer.length < offset + length) return;
        offset += length;
      }
    });
    socket.on("error", () => undefined);
  });
  return new Promise<{ server: net.Server; port: number }>(resolve => server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as net.AddressInfo).port })));
}

describe.skipIf(skipMysqlSuite())("workspace artifacts + universal search on real SQL", () => {
  let database: TestDatabase;
  let clamd: Awaited<ReturnType<typeof startFakeClamd>>;
  let m: { db: typeof import("../db"); routers: typeof import("../routers"); gateway: typeof import("../gateway"); schema: typeof import("../../drizzle/schema") };
  let userA: any, userB: any, userC: any, wsA: number, wsB: number;
  const shared: { projectId: number; otherProjectId: number; bProjectId: number; english?: { artifactId: number; conversationId: number; messageId: number }; tamilArtifactId?: number } = { projectId: 0, otherProjectId: 0, bProjectId: 0 };

  const callerFor = (user: any) => m.routers.appRouter.createCaller({ user, req: { protocol: "https", headers: {} } as Request, res: { headersSent: false, setHeader: () => undefined, clearCookie: () => undefined } as any, requestId: "artifacts-it" } as any);
  const rows = async <T = Record<string, any>>(query: ReturnType<typeof sql>) => ((await database.db.execute(query)) as unknown as [T[]])[0];
  const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");
  const stubGateway = (reply: string | null) => {
    const config = m.gateway.loadGatewayConfig({ LOCAL_LLM_API_URL: "http://local.it.invalid", LOCAL_LLM_MODEL: "it-model" });
    const gw = m.gateway.createProviderGateway(config, { log: () => undefined, adapterFactory: binding => ({ providerId: binding.providerId, complete: async () => { if (reply === null) throw new m.gateway.ProviderCallError("server_error", 503); return { content: reply, finishReason: "stop", usage: null, attempts: 1 }; } }) });
    m.gateway.setProviderGatewayForTests(gw);
  };
  const artifactCount = async (where = sql`1=1`) => Number((await rows<{ n: number }>(sql`SELECT COUNT(*) n FROM artifacts WHERE ${where}`))[0].n);

  beforeAll(async () => {
    database = await createTestDatabase();
    clamd = await startFakeClamd();
    Object.assign(process.env, { DATABASE_URL: database.url, DATABASE_EXPECTED_NAME: database.name, JWT_SECRET: "integration-test-secret-not-real-0123456789", VITE_APP_ID: "sakthiai-it", MALWARE_SCANNER_HOST: "127.0.0.1", MALWARE_SCANNER_PORT: String(clamd.port), MALWARE_SCANNER_TIMEOUT_MS: "2000" });
    for (const key of ["LLM_API_URL", "LOCAL_LLM_API_URL", "EMBEDDING_API_URL", "LOCAL_EMBEDDING_API_URL", "GATEWAY_ALLOW_EXTERNAL"]) delete process.env[key];
    m = { db: await import("../db"), routers: await import("../routers"), gateway: await import("../gateway"), schema: await import("../../drizzle/schema") };
    for (const [openId, name] of [["art-user-a", "Alice"], ["art-user-b", "Bhavya"], ["art-user-c", "Chitra"]]) await m.db.upsertUser({ openId, name, email: `${openId}@example.test`, loginMethod: "test" });
    userA = await m.db.getUserByOpenId("art-user-a"); userB = await m.db.getUserByOpenId("art-user-b"); userC = await m.db.getUserByOpenId("art-user-c");
    wsA = (await m.db.ensureWorkspace(userA)).id; wsB = (await m.db.ensureWorkspace(userB)).id;
    // C is a plain MEMBER of workspace A (not the owner of A's conversations).
    await database.db.insert(m.schema.workspaceMembers).values({ workspaceId: wsA, userId: userC.id, role: "member" });
    // Fixture seeding only: PR #29's upload gate (default OFF) is opened just for these two uploads and closed again, so
    // every artifact/search assertion below runs under the beta default (uploads disabled, existing files still searchable).
    process.env.FILE_INGESTION_BACKEND_ENABLED = "true";
    try {
      await callerFor(userA).files.upload({ workspaceId: wsA, filename: "temples.txt", mimeType: "text/plain", dataBase64: b64(TEMPLES_TXT) });
      await callerFor(userB).files.upload({ workspaceId: wsB, filename: "b-secret.txt", mimeType: "text/plain", dataBase64: b64(B_SECRET_TXT) });
    } finally {
      delete process.env.FILE_INGESTION_BACKEND_ENABLED;
    }
    await callerFor(userA).projects.create({ workspaceId: wsA, name: "Temples" });
    await callerFor(userA).projects.create({ workspaceId: wsA, name: "Other" });
    await callerFor(userB).projects.create({ workspaceId: wsB, name: "B project" });
    const a = await callerFor(userA).projects.list({ workspaceId: wsA });
    shared.projectId = a.find(p => p.name === "Temples")!.id; shared.otherProjectId = a.find(p => p.name === "Other")!.id;
    shared.bProjectId = (await callerFor(userB).projects.list({ workspaceId: wsB }))[0].id;
  });
  afterAll(async () => { clamd?.server.close(); m?.gateway.setProviderGatewayForTests(null); await database?.close(); });

  it("migration 0013 created artifacts with mediumtext content/searchText and the (workspaceId, sourceMessageId) unique key", async () => {
    const columns = await rows<{ c: string; t: string }>(sql`SELECT COLUMN_NAME c, DATA_TYPE t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ${database.name} AND TABLE_NAME = 'artifacts'`);
    const type = Object.fromEntries(columns.map(c => [c.c, c.t]));
    expect(type).toMatchObject({ content: "mediumtext", searchText: "mediumtext", citationsJson: "text", title: "varchar", language: "enum" });
    const idx = await rows<{ n: string; col: string; seq: number; nu: number }>(sql`SELECT INDEX_NAME n, COLUMN_NAME col, SEQ_IN_INDEX seq, NON_UNIQUE nu FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ${database.name} AND TABLE_NAME = 'artifacts' AND INDEX_NAME = 'artifacts_workspace_source_message_uq' ORDER BY SEQ_IN_INDEX`);
    expect(idx.map(i => i.col)).toEqual(["workspaceId", "sourceMessageId"]);
    expect(Number(idx[0].nu)).toBe(0);
  });

  describe("the journey: chat answer -> artifact -> list/get -> search -> reopen", () => {
    it("saves a real grounded answer; content and evidence come from the stored message, and it persists", async () => {
      stubGateway("The Murugan temple opens at 6am. [1]");
      const a = callerFor(userA);
      const send = await a.chat.send({ workspaceId: wsA, message: "Murugan temple opens at what time" });
      expect(send.grounding).toBe("GROUNDED_EVIDENCE");
      expect(send.assistantMessageId).toBeGreaterThan(0);

      const saved = await a.artifacts.saveFromMessage({ workspaceId: wsA, conversationId: send.conversationId, messageId: send.assistantMessageId!, projectId: shared.projectId, title: "Temple timings" });
      expect(saved.created).toBe(true);
      const [stored] = await rows<{ content: string; citationsJson: string }>(sql`SELECT content, citationsJson FROM messages WHERE id = ${send.assistantMessageId!}`);
      expect(saved.artifact).toMatchObject({ title: "Temple timings", kind: "chat_answer", projectId: shared.projectId, language: "en", createdByUserId: userA.id, sourceConversationId: send.conversationId, sourceMessageId: send.assistantMessageId });
      expect(saved.artifact.content).toBe(stored.content.trim());
      expect(saved.artifact.citations).toEqual(JSON.parse(stored.citationsJson));
      expect(saved.artifact.citations[0]).toMatchObject({ filename: "temples.txt" });
      shared.english = { artifactId: saved.artifact.id, conversationId: send.conversationId, messageId: send.assistantMessageId! };

      // persisted in SQL, with a populated search index
      const [row] = await rows<{ workspaceId: number; searchText: string; contentHash: string }>(sql`SELECT workspaceId, searchText, contentHash FROM artifacts WHERE id = ${saved.artifact.id}`);
      expect(row.workspaceId).toBe(wsA);
      expect(row.searchText.length).toBeGreaterThan(10);
      expect(row.contentHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("lists summaries (no body, no evidence) and filters by project; get reopens the full artifact with its evidence", async () => {
      const a = callerFor(userA); const { artifactId } = shared.english!;
      const all = await a.artifacts.list({ workspaceId: wsA });
      const item = all.find(x => x.id === artifactId)!;
      expect(item).toBeDefined();
      expect(item).not.toHaveProperty("content"); expect(item).not.toHaveProperty("citations"); expect(item).not.toHaveProperty("searchText");
      expect((await a.artifacts.list({ workspaceId: wsA, projectId: shared.projectId })).map(x => x.id)).toContain(artifactId);
      expect((await a.artifacts.list({ workspaceId: wsA, projectId: shared.otherProjectId })).map(x => x.id)).not.toContain(artifactId);
      const opened = await a.artifacts.get({ workspaceId: wsA, artifactId });
      expect(opened.content).toContain("6am");
      expect(opened.citations.length).toBeGreaterThan(0);
      expect(opened).not.toHaveProperty("searchText");
    });

    it("search finds the artifact by body, by TITLE, and across scripts (Tamil query finds the English 'Murugan' text at half weight), plus the source file", async () => {
      const a = callerFor(userA); const { artifactId } = shared.english!;
      const byBody = await a.search.workspace({ workspaceId: wsA, query: "temple opens" });
      expect(byBody.artifacts[0]).toMatchObject({ id: artifactId, title: "Temple timings", retrievalMethod: "lexical" });
      expect(byBody.artifacts[0].snippet).toContain("6am");
      expect(byBody.documents.map(d => d.filename)).toContain("temples.txt");
      expect(byBody.lowInformation).toBe(false);

      const byTitle = await a.search.workspace({ workspaceId: wsA, query: "timings" }); // 'timings' is only in the title
      expect(byTitle.artifacts.map(x => x.id)).toContain(artifactId);

      const crossScript = await a.search.workspace({ workspaceId: wsA, query: "முருகன்" });
      const hit = crossScript.artifacts.find(x => x.id === artifactId)!;
      expect(hit).toBeDefined();
      expect(hit.score).toBeCloseTo(0.5, 5);
      expect(crossScript.documents.map(d => d.filename)).toContain("temples.txt");
    });

    it("a Tamil answer is saved with language 'ta'; Tamil and Tanglish queries find it and rank direct Tamil above the cross-script match", async () => {
      stubGateway(TAMIL_REPLY);
      const a = callerFor(userA);
      const send = await a.chat.send({ workspaceId: wsA, message: "முருகன் கோவில் எங்கு உள்ளது", language: "ta" });
      expect(send.grounding).toBe("GROUNDED_EVIDENCE");
      const saved = await a.artifacts.saveFromMessage({ workspaceId: wsA, conversationId: send.conversationId, messageId: send.assistantMessageId!, title: "கோவில் நேரம்" });
      expect(saved.artifact).toMatchObject({ language: "ta", title: "கோவில் நேரம்", projectId: null });
      shared.tamilArtifactId = saved.artifact.id;

      const tamil = await a.search.workspace({ workspaceId: wsA, query: "முருகன்" });
      expect(tamil.artifacts.map(x => x.id).slice(0, 2)).toEqual([saved.artifact.id, shared.english!.artifactId]);
      expect(tamil.artifacts[0].score).toBeGreaterThan(tamil.artifacts[1].score);
      const tanglish = await a.search.workspace({ workspaceId: wsA, query: "murugan kovil" });
      expect(tanglish.artifacts.map(x => x.id)).toContain(saved.artifact.id);
    });
  });

  describe("idempotency", () => {
    it("saving the same answer again returns the existing artifact; a concurrent burst creates exactly one row", async () => {
      const a = callerFor(userA); const first = shared.english!;
      const again = await a.artifacts.saveFromMessage({ workspaceId: wsA, conversationId: first.conversationId, messageId: first.messageId, title: "A different title is ignored" });
      expect(again).toMatchObject({ created: false });
      expect(again.artifact.id).toBe(first.artifactId);
      expect(again.artifact.title).toBe("Temple timings");

      stubGateway("Race answer text about the temple opening. [1]");
      const send = await a.chat.send({ workspaceId: wsA, message: "Murugan temple opens at what time" });
      const burst = await Promise.all(Array.from({ length: 6 }, () => a.artifacts.saveFromMessage({ workspaceId: wsA, conversationId: send.conversationId, messageId: send.assistantMessageId! })));
      expect(burst.filter(r => r.created)).toHaveLength(1);
      expect(new Set(burst.map(r => r.artifact.id)).size).toBe(1);
      expect(await artifactCount(sql`sourceMessageId = ${send.assistantMessageId!}`)).toBe(1);
    });
  });

  describe("security: tenancy, ownership, forgery", () => {
    it("a non-member is refused on every procedure (workspace membership is checked first)", async () => {
      const b = callerFor(userB); const { artifactId, conversationId, messageId } = shared.english!;
      await expect(b.artifacts.saveFromMessage({ workspaceId: wsA, conversationId, messageId })).rejects.toMatchObject({ code: "FORBIDDEN", message: "Workspace access denied" });
      await expect(b.artifacts.list({ workspaceId: wsA })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(b.artifacts.get({ workspaceId: wsA, artifactId })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(b.search.workspace({ workspaceId: wsA, query: "temple" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("a member of another workspace cannot reach an artifact by guessing its id: indistinguishable from missing; lists and searches are empty", async () => {
      const b = callerFor(userB); const { artifactId } = shared.english!;
      await expect(b.artifacts.get({ workspaceId: wsB, artifactId })).rejects.toMatchObject({ code: "NOT_FOUND", message: "Artifact not found" });
      expect(await b.artifacts.list({ workspaceId: wsB })).toEqual([]);
      const leak = await b.search.workspace({ workspaceId: wsB, query: "temple opens murugan" });
      expect(leak.artifacts).toEqual([]);
      expect(leak.documents).toEqual([]);
      // B's own data is found by B only
      expect((await b.search.workspace({ workspaceId: wsB, query: "TENANT-B-ONLY-MARKER" })).documents.map(d => d.filename)).toEqual(["b-secret.txt"]);
      const aSees = await callerFor(userA).search.workspace({ workspaceId: wsA, query: "TENANT-B-ONLY-MARKER zephyrbudget" });
      expect(aSees.documents).toEqual([]); expect(aSees.artifacts).toEqual([]);
    });

    it("cannot save from another tenant's conversation or message, or into another tenant's workspace/project", async () => {
      stubGateway("Workspace B answer. [1]");
      const b = callerFor(userB); const a = callerFor(userA);
      const bSend = await b.chat.send({ workspaceId: wsB, message: "zephyrbudget confidential figures" });
      expect(bSend.grounding).toBe("GROUNDED_EVIDENCE");
      const before = await artifactCount();
      // A's workspace + B's conversation
      await expect(a.artifacts.saveFromMessage({ workspaceId: wsA, conversationId: bSend.conversationId, messageId: bSend.assistantMessageId! })).rejects.toMatchObject({ code: "FORBIDDEN", message: "Conversation access denied" });
      // A's own conversation + B's message id
      await expect(a.artifacts.saveFromMessage({ workspaceId: wsA, conversationId: shared.english!.conversationId, messageId: bSend.assistantMessageId! })).rejects.toMatchObject({ code: "NOT_FOUND" });
      // B's workspace (A is not a member)
      await expect(a.artifacts.saveFromMessage({ workspaceId: wsB, conversationId: bSend.conversationId, messageId: bSend.assistantMessageId! })).rejects.toMatchObject({ code: "FORBIDDEN", message: "Workspace access denied" });
      // B's project from A's workspace
      await expect(a.artifacts.saveFromMessage({ workspaceId: wsA, conversationId: shared.english!.conversationId, messageId: shared.english!.messageId, projectId: shared.bProjectId })).rejects.toMatchObject({ code: "FORBIDDEN", message: "Project access denied" });
      expect(await artifactCount()).toBe(before);
    });

    it("a workspace member who does not own the conversation cannot save from it, but a saved artifact is workspace-shared by design", async () => {
      const c = callerFor(userC); const { artifactId, conversationId, messageId } = shared.english!;
      await expect(c.artifacts.saveFromMessage({ workspaceId: wsA, conversationId, messageId })).rejects.toMatchObject({ code: "FORBIDDEN", message: "Conversation access denied" });
      expect((await c.artifacts.get({ workspaceId: wsA, artifactId })).content).toContain("6am");
      expect((await c.artifacts.list({ workspaceId: wsA })).map(x => x.id)).toContain(artifactId);
    });

    it("the client cannot forge content or evidence: unknown fields are ignored, content always comes from the stored message", async () => {
      stubGateway("Genuine stored answer for the forgery test. [1]");
      const a = callerFor(userA);
      const send = await a.chat.send({ workspaceId: wsA, message: "Murugan temple opens at what time" });
      const forged: any = { workspaceId: wsA, conversationId: send.conversationId, messageId: send.assistantMessageId!, title: `Safe${RLO}Title`, content: "FORGED CONTENT", citations: [{ filename: "evil.txt", documentId: 1, excerpt: "FORGED" }], citationsJson: "[]", searchText: "forged" };
      const saved = await a.artifacts.saveFromMessage(forged);
      expect(saved.artifact.content).toBe("Genuine stored answer for the forgery test. [1]");
      expect(JSON.stringify(saved.artifact.citations)).not.toContain("FORGED");
      expect(saved.artifact.citations[0]).toMatchObject({ filename: "temples.txt" });
      expect(saved.artifact.title).toBe("Safe Title"); // bidi override stripped
      expect((await rows<{ searchText: string }>(sql`SELECT searchText FROM artifacts WHERE id = ${saved.artifact.id}`))[0].searchText).not.toContain("forged");
    });
  });

  describe("only real answers can become artifacts", () => {
    it("refuses INSUFFICIENT_EVIDENCE, the MODEL_UNAVAILABLE notice (persisted WITH citations), user messages and unknown ids", async () => {
      const a = callerFor(userA);
      const insufficient = await a.chat.send({ workspaceId: wsA, message: "quantum chromodynamics lattice" });
      expect(insufficient.grounding).toBe("INSUFFICIENT_EVIDENCE");
      await expect(a.artifacts.saveFromMessage({ workspaceId: wsA, conversationId: insufficient.conversationId, messageId: insufficient.assistantMessageId! })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

      stubGateway(null);
      const outage = await a.chat.send({ workspaceId: wsA, message: "Murugan temple opens at what time" });
      expect(outage.grounding).toBe("MODEL_UNAVAILABLE");
      expect(outage.citations.length).toBeGreaterThan(0);
      expect(outage.answer).toBe(modelUnavailableMessage("en", outage.citations.length));
      await expect(a.artifacts.saveFromMessage({ workspaceId: wsA, conversationId: outage.conversationId, messageId: outage.assistantMessageId! })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringMatching(/grounded/i) });

      const [userMessage] = await rows<{ id: number }>(sql`SELECT id FROM messages WHERE conversationId = ${outage.conversationId} AND role = 'user'`);
      await expect(a.artifacts.saveFromMessage({ workspaceId: wsA, conversationId: outage.conversationId, messageId: userMessage.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(a.artifacts.saveFromMessage({ workspaceId: wsA, conversationId: outage.conversationId, messageId: 999_999 })).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(await artifactCount(sql`sourceMessageId IN (${insufficient.assistantMessageId!}, ${outage.assistantMessageId!}, ${userMessage.id})`)).toBe(0);
    });
  });

  describe("lifecycle: rename, move, delete", () => {
    const grounded = async (user: any, question: string, projectId?: number, title?: string) => {
      stubGateway("The Murugan temple opens at 6am. [1]");
      const c = callerFor(user);
      const send = await c.chat.send({ workspaceId: wsA, message: question });
      expect(send.grounding).toBe("GROUNDED_EVIDENCE");
      const saved = await c.artifacts.saveFromMessage({ workspaceId: wsA, conversationId: send.conversationId, messageId: send.assistantMessageId!, projectId, title });
      return { artifact: saved.artifact, conversationId: send.conversationId, messageId: send.assistantMessageId! };
    };
    const snapshot = async (id: number) => (await rows<{ content: string; citationsJson: string; contentHash: string; sourceMessageId: number; createdByUserId: number }>(sql`SELECT content, citationsJson, contentHash, sourceMessageId, createdByUserId FROM artifacts WHERE id = ${id}`))[0];

    it("the creator renames: title is sanitized, search follows the new title, evidence/content/provenance are untouched", async () => {
      const a = callerFor(userA);
      const made = await grounded(userA, "Murugan temple opens in the morning", undefined, "Obsolete heading");
      const before = await snapshot(made.artifact.id);
      const renamed = await a.artifacts.update({ workspaceId: wsA, artifactId: made.artifact.id, title: `  Zanzibar${RLO} lifecycle\u0000 title  ` });
      expect(renamed.title).toBe("Zanzibar lifecycle title");
      expect(renamed.content).toBe(made.artifact.content);
      expect(renamed.citations).toEqual(made.artifact.citations);
      expect(await snapshot(made.artifact.id)).toEqual(before);
      const found = await a.search.workspace({ workspaceId: wsA, query: "zanzibar" });
      expect(found.artifacts.map(x => x.id)).toEqual([made.artifact.id]);
      expect((await a.search.workspace({ workspaceId: wsA, query: "obsolete" })).artifacts.map(x => x.id)).not.toContain(made.artifact.id);
      await expect(a.artifacts.update({ workspaceId: wsA, artifactId: made.artifact.id, title: `${RLO}\u200b  ` })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await expect(a.artifacts.update({ workspaceId: wsA, artifactId: made.artifact.id })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect((await a.artifacts.get({ workspaceId: wsA, artifactId: made.artifact.id })).title).toBe("Zanzibar lifecycle title");
    });

    it("moves between projects and out of a project; a project from another tenant (or a missing one) is refused", async () => {
      const a = callerFor(userA);
      const made = await grounded(userA, "Murugan temple opens move test", shared.projectId);
      expect((await a.artifacts.update({ workspaceId: wsA, artifactId: made.artifact.id, projectId: shared.otherProjectId })).projectId).toBe(shared.otherProjectId);
      expect((await a.artifacts.list({ workspaceId: wsA, projectId: shared.otherProjectId })).map(x => x.id)).toContain(made.artifact.id);
      expect((await a.artifacts.list({ workspaceId: wsA, projectId: shared.projectId })).map(x => x.id)).not.toContain(made.artifact.id);
      expect((await a.artifacts.update({ workspaceId: wsA, artifactId: made.artifact.id, projectId: null })).projectId).toBeNull();
      await expect(a.artifacts.update({ workspaceId: wsA, artifactId: made.artifact.id, projectId: shared.bProjectId })).rejects.toMatchObject({ code: "FORBIDDEN", message: "Project access denied" });
      await expect(a.artifacts.update({ workspaceId: wsA, artifactId: made.artifact.id, projectId: 987654 })).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect((await a.artifacts.get({ workspaceId: wsA, artifactId: made.artifact.id })).projectId).toBeNull();
    });

    it("only the saver or a workspace owner may change an artifact: a plain member cannot touch another member's, the owner can", async () => {
      const mine = await grounded(userA, "Murugan temple opens owner artifact");
      const hers = await grounded(userC, "Murugan temple opens member artifact");
      const c = callerFor(userC); const a = callerFor(userA);
      // C is a plain member: can read A's artifact (workspace-shared) but not change or delete it
      expect((await c.artifacts.get({ workspaceId: wsA, artifactId: mine.artifact.id })).id).toBe(mine.artifact.id);
      await expect(c.artifacts.update({ workspaceId: wsA, artifactId: mine.artifact.id, title: "Hijacked" })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(c.artifacts.update({ workspaceId: wsA, artifactId: mine.artifact.id, projectId: shared.projectId })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(c.artifacts.delete({ workspaceId: wsA, artifactId: mine.artifact.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect((await a.artifacts.get({ workspaceId: wsA, artifactId: mine.artifact.id })).title).not.toBe("Hijacked");
      // C can manage her own
      expect((await c.artifacts.update({ workspaceId: wsA, artifactId: hers.artifact.id, title: "Chitra's note" })).title).toBe("Chitra's note");
      // A is the workspace owner: can rename and delete C's
      expect((await a.artifacts.update({ workspaceId: wsA, artifactId: hers.artifact.id, title: "Owner tidy-up" })).title).toBe("Owner tidy-up");
      expect(await a.artifacts.delete({ workspaceId: wsA, artifactId: hers.artifact.id })).toEqual({ deleted: true });
    });

    it("another tenant cannot rename, move or delete: forbidden against the real workspace, not-found against its own; the row is untouched", async () => {
      const made = await grounded(userA, "Murugan temple opens tenant test", undefined, "Tenant guarded");
      const before = await snapshot(made.artifact.id);
      const b = callerFor(userB);
      for (const call of [
        () => b.artifacts.update({ workspaceId: wsA, artifactId: made.artifact.id, title: "pwned" }),
        () => b.artifacts.delete({ workspaceId: wsA, artifactId: made.artifact.id }),
      ]) await expect(call()).rejects.toMatchObject({ code: "FORBIDDEN", message: "Workspace access denied" });
      for (const call of [
        () => b.artifacts.update({ workspaceId: wsB, artifactId: made.artifact.id, title: "pwned" }),
        () => b.artifacts.update({ workspaceId: wsB, artifactId: made.artifact.id, projectId: shared.bProjectId }),
        () => b.artifacts.delete({ workspaceId: wsB, artifactId: made.artifact.id }),
      ]) await expect(call()).rejects.toMatchObject({ code: "NOT_FOUND", message: "Artifact not found" });
      expect(await snapshot(made.artifact.id)).toEqual(before);
      expect((await callerFor(userA).artifacts.get({ workspaceId: wsA, artifactId: made.artifact.id })).title).toBe("Tenant guarded");
    });

    it("delete removes only the artifact: gone from get/list/search, second delete is not-found, chat and files remain, and the answer can be saved again", async () => {
      const a = callerFor(userA);
      const made = await grounded(userA, "Murugan temple opens delete test", shared.projectId, "Quokkaterminal entry");
      expect((await a.search.workspace({ workspaceId: wsA, query: "quokkaterminal" })).artifacts.map(x => x.id)).toEqual([made.artifact.id]);
      const docsBefore = await rows<{ n: number }>(sql`SELECT COUNT(*) n FROM documents WHERE workspaceId = ${wsA}`);

      expect(await a.artifacts.delete({ workspaceId: wsA, artifactId: made.artifact.id })).toEqual({ deleted: true });
      await expect(a.artifacts.get({ workspaceId: wsA, artifactId: made.artifact.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect((await a.artifacts.list({ workspaceId: wsA })).map(x => x.id)).not.toContain(made.artifact.id);
      expect((await a.search.workspace({ workspaceId: wsA, query: "quokkaterminal" })).artifacts).toEqual([]);
      await expect(a.artifacts.delete({ workspaceId: wsA, artifactId: made.artifact.id })).rejects.toMatchObject({ code: "NOT_FOUND" });

      expect(Number((await rows<{ n: number }>(sql`SELECT COUNT(*) n FROM messages WHERE id = ${made.messageId}`))[0].n)).toBe(1);
      expect(Number((await rows<{ n: number }>(sql`SELECT COUNT(*) n FROM documents WHERE workspaceId = ${wsA}`))[0].n)).toBe(Number(docsBefore[0].n));
      const again = await a.artifacts.saveFromMessage({ workspaceId: wsA, conversationId: made.conversationId, messageId: made.messageId });
      expect(again.created).toBe(true);
      expect(again.artifact.id).not.toBe(made.artifact.id);
    });
  });

  describe("search behaviour on real SQL", () => {
    const seed = async (workspaceId: number, title: string, content: string) => {
      await database.db.insert(m.schema.artifacts).values({ workspaceId, createdByUserId: userA.id, kind: "chat_answer", title, language: "en", content, contentHash: "0".repeat(64), searchText: searchTextFor(`${title}\n${content}`) });
    };

    it("candidate selection is DB-side by matched-term count, not 'newest N rows': an old two-term match beats 130 newer one-term matches", async () => {
      await seed(wsA, "needle", "the quokka and the wombat were both here");
      for (let i = 0; i < 130; i += 1) await seed(wsA, `filler ${i}`, `quokka sighting number ${i} only`);
      expect(await artifactCount(sql`workspaceId = ${wsA} AND content LIKE '%quokka%'`)).toBeGreaterThan(100); // more matches than the candidate cap
      const result = await callerFor(userA).search.workspace({ workspaceId: wsA, query: "quokka wombat", limit: 5 });
      expect(result.artifacts).toHaveLength(5);
      expect(result.artifacts[0].title).toBe("needle");
      expect(result.artifacts[0].score).toBeGreaterThan(result.artifacts[1].score);
      // the same data in the other tenant is invisible
      expect((await callerFor(userB).search.workspace({ workspaceId: wsB, query: "quokka wombat" })).artifacts).toEqual([]);
    });

    it("stopword-only queries return nothing and say so; hostile query text is inert and responses never carry index columns", async () => {
      const a = callerFor(userA);
      const low = await a.search.workspace({ workspaceId: wsA, query: "what is the" });
      expect(low).toMatchObject({ lowInformation: true, artifacts: [], documents: [] });
      for (const query of ["' OR '1'='1' --", "%", "_", "a%b_c", "\"; DROP TABLE artifacts; --", "temple') UNION SELECT searchText FROM artifacts --"]) {
        const result = await a.search.workspace({ workspaceId: wsA, query });
        expect(Array.isArray(result.artifacts)).toBe(true);
      }
      expect(await artifactCount()).toBeGreaterThan(0); // table intact
      const sample = JSON.stringify(await a.search.workspace({ workspaceId: wsA, query: "temple opens" }));
      for (const forbidden of ["searchText", "embeddingJson", "citationsJson", "contentHash"]) expect(sample).not.toContain(forbidden);
    });
  });
});
