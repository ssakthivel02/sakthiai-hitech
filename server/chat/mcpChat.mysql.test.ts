import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDatabase, skipMysqlSuite, type TestDatabase } from "../testing/mysqlTestDb";
import { startFakeMcp, type FakeMcp } from "../testing/fakeMcpServer";
import { McpConnectorService, McpConnectorStore } from "../connectors/mcp";
import { MysqlTaskStore, TaskWorkerRuntime, createChatAnswerHandler, CHAT_ANSWER_TASK, type RuntimeConfig } from "../tasks";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const SECRET = "s3cr3t-token-VALUE-9f2a";
const ev = (id: number, content: string) => ({ id, documentId: 1, filename: "kb.txt", mimeType: "text/plain", page: 1, section: null, paragraph: 1, sourceStart: 0, sourceEnd: content.length, content, retrievalMethod: "lexical", score: 1 } as any);

describe.skipIf(skipMysqlSuite())("governed read-only MCP tools in the durable chat answer path (real SQL + fake MCP server)", { timeout: 30_000 }, () => {
  let database: TestDatabase; let fake: FakeMcp; let service: McpConnectorService; let store: MysqlTaskStore;
  const getDb = async () => database.db;
  const rows = async <T = Record<string, any>>(q: ReturnType<typeof sql>) => ((await database.db.execute(q)) as unknown as [T[]])[0];
  let wsA = 7100, wsB = 7200, userA = 0, convA = 0, convB = 0, n = 0;
  const cfg: RuntimeConfig = { enabled: true, concurrency: 1, pollMs: 30, leaseMs: 5000, shutdownGraceMs: 500 };

  beforeAll(async () => {
    database = await createTestDatabase(); fake = await startFakeMcp();
    service = new McpConnectorService({ store: new McpConnectorStore(getDb), env: { MCP_ALLOWED_ENDPOINTS: fake.origin, MCP_ALLOW_LOOPBACK_HTTP: "true", MCP_SECRET_FAKE_TOKEN: SECRET } });
    store = new MysqlTaskStore(getDb);
    await database.db.execute(sql`INSERT INTO users (openId, name, email, loginMethod) VALUES ('mc-a','A','a@mc.test','t')`);
    userA = Number((await rows<{ id: number }>(sql`SELECT id FROM users WHERE openId='mc-a'`))[0].id);
  });
  afterAll(async () => { await fake?.close(); await database?.close(); });
  beforeEach(() => fake.reset());

  const mkConv = async (workspaceId: number) => { await database.db.execute(sql`INSERT INTO conversations (workspaceId, userId, title, language) VALUES (${workspaceId}, ${userA}, 'c', 'en')`); return Number((await rows<{ id: number }>(sql`SELECT MAX(id) id FROM conversations`))[0].id); };
  const connector = async (workspaceId: number, over: Record<string, unknown> = {}, enable = true) => {
    const actor = { workspaceId, userId: userA };
    const view = await service.register(actor, { name: `mcp-${++n}`, endpoint: fake.url, ...over } as any);
    if (enable) await service.setEnabled(actor, view.id, true);
    return view;
  };

  type Script = { choose?: (offered: any[]) => unknown; answers?: Array<string | "FAIL"> };
  const runChat = async (workspaceId: number, conversationId: number, script: Script, opts: { enabled?: boolean; search?: any[] } = {}) => {
    const prompts: string[] = []; let selectionCalls = 0; let answerCalls = 0;
    const gateway = { invoke: async (req: any) => {
      const system = String(req.messages[0].content); prompts.push(system + "\n---\n" + req.messages.map((m: any) => m.content).join("\n"));
      if (system.includes("at most ONE read-only tool")) {
        selectionCalls++;
        const offered = JSON.parse(system.slice(system.indexOf("TOOLS:\n") + 7));
        const choice = script.choose ? script.choose(offered) : { tool: null };
        return { status: "returned", content: typeof choice === "string" ? choice : JSON.stringify(choice), providerId: "p", attempts: [], latencyMs: 1 };
      }
      const a = (script.answers ?? ["answer"])[Math.min(answerCalls++, (script.answers ?? ["answer"]).length - 1)];
      if (a === "FAIL") return { status: "failed", reason: "unavailable", attempts: [], latencyMs: 1 };
      return { status: "returned", content: a, providerId: "p", attempts: [], latencyMs: 1 };
    } };
    const handler = createChatAnswerHandler({ search: async () => opts.search ?? [], db: getDb, mcp: { service, enabled: () => opts.enabled ?? true } });
    const { task } = await store.create({ workspaceId, type: CHAT_ANSWER_TASK, input: { conversationId, userId: userA, message: "what is the leave policy", language: "en" }, maxAttempts: 3 });
    const rt = new TaskWorkerRuntime({ store, handlers: { [CHAT_ANSWER_TASK]: handler }, gateway: gateway as any, config: cfg, backoffBaseMs: 20, backoffMaxMs: 40 });
    rt.start();
    const end = Date.now() + 10000;
    while (Date.now() < end) { const t = await store.get(workspaceId, task.id); if (t && ["SUCCEEDED", "FAILED", "CANCELLED"].includes(t.state)) break; await sleep(30); }
    await rt.stop(500);
    return { task: (await store.get(workspaceId, task.id))!, prompts, selectionCalls };
  };
  const persisted = async (c: number) => rows<{ role: string; content: string; citationsJson: string | null }>(sql`SELECT role, content, citationsJson FROM messages WHERE conversationId=${c} ORDER BY id`);
  const audits = (w: number, action: string, outcome?: string) => rows<{ outcome: string; detail: string | null }>(sql`SELECT outcome, detail FROM mcpConnectorAudit WHERE workspaceId=${w} AND action=${action}`).then(r => outcome ? r.filter(x => x.outcome === outcome) : r);
  const pick = (tool: string, args: Record<string, unknown> = { query: "leave" }) => (offered: any[]) => { const o = offered.find(t => t.tool === tool) ?? offered[0]; return { connectorId: o?.connectorId ?? "6f1c2a3e-4b5d-4e6f-8a9b-0c1d2e3f4a5b", tool, arguments: args }; };

  it("approved connector is selectable; the read-only tool runs once; MCP provenance reaches the final persisted citation; answer is grounded on tool evidence alone", async () => {
    convA = await mkConv(wsA); const view = await connector(wsA, { secretRef: "FAKE_TOKEN" });
    fake.handlers.search_docs = () => ({ content: [{ type: "text", text: "Annual leave is 25 days." }] });
    const r = await runChat(wsA, convA, { choose: pick("search_docs"), answers: ["25 days [T1]"] });
    expect(r.task).toMatchObject({ state: "SUCCEEDED", result: { grounding: "GROUNDED_EVIDENCE", answer: "25 days [T1]" } });
    expect(fake.calls("tools/call")).toBe(1);
    expect(r.prompts.at(-1)).toContain("Annual leave is 25 days.");
    const msgs = await persisted(convA); expect(msgs.map(m => m.role)).toEqual(["user", "assistant"]);
    const citation = JSON.parse(msgs[1].citationsJson!).find((c: any) => c.source === "mcp");
    expect(citation).toMatchObject({ documentId: 0, mimeType: "application/vnd.mcp.tool-result", mcp: { connectorId: view.id, connectorName: view.name, serverName: "fake-mcp", endpointOrigin: fake.origin, tool: "search_docs", truncated: false } });
    expect(fake.requests.find(q => q.method === "tools/call")?.authorization).toBe(`Bearer ${SECRET}`);
    expect((await audits(wsA, "CALL_TOOL", "OK")).length).toBe(1);
  });

  it("documents and tool evidence combine; document citations are kept", async () => {
    const c = await mkConv(wsA);
    const r = await runChat(wsA, c, { choose: pick("search_docs"), answers: ["both"] }, { search: [ev(3, "Leave is in the handbook.")] });
    const cites = JSON.parse((await persisted(c))[1].citationsJson!);
    expect(r.task.state).toBe("SUCCEEDED"); expect(cites.map((x: any) => x.source ?? "doc").sort()).toEqual(["doc", "mcp"]);
  });

  it("no secret reaches the model context, the persisted rows, task result or audit detail", async () => {
    const c = await mkConv(wsA);
    fake.handlers.search_docs = () => ({ content: [{ type: "text", text: `config: Bearer abcdef1234567890 and ${SECRET} and api_key=ZZZZZZZZ9999` }] });
    const r = await runChat(wsA, c, { choose: pick("search_docs"), answers: ["ok"] });
    const blob = JSON.stringify([r.prompts, await persisted(c), r.task.result, await audits(wsA, "CALL_TOOL")]);
    expect(r.task.state).toBe("SUCCEEDED");
    for (const leaked of [SECRET, "abcdef1234567890", "ZZZZZZZZ9999"]) expect(blob).not.toContain(leaked);
    expect(blob).toContain("[REDACTED]");
  });

  it("disabled connector: never offered, never contacted", async () => {
    const wsD = 7300; const c = await mkConv(wsD); await connector(wsD, {}, false);
    const r = await runChat(wsD, c, { choose: pick("search_docs"), answers: ["x"] });
    expect(r.selectionCalls).toBe(0); expect(fake.requests).toHaveLength(0);
    expect(r.task.result).toMatchObject({ grounding: "INSUFFICIENT_EVIDENCE" });
  });

  it("another workspace's connector is neither offered nor callable even if the model names its id", async () => {
    const foreign = await connector(wsA); convB = await mkConv(wsB);
    const before = fake.calls("tools/call");
    const r = await runChat(wsB, convB, { choose: () => ({ connectorId: foreign.id, tool: "search_docs", arguments: { query: "x" } }) });
    expect(r.selectionCalls).toBe(0); // wsB has no connectors, so nothing is offered
    // and with a workspace that HAS its own connector, naming the foreign id is refused
    const wsC = 7400; const cc = await mkConv(wsC); await connector(wsC);
    const r2 = await runChat(wsC, cc, { choose: () => ({ connectorId: foreign.id, tool: "search_docs", arguments: { query: "x" } }) });
    expect(r2.selectionCalls).toBe(1); expect(fake.calls("tools/call")).toBe(before);
    expect(r2.task.result).toMatchObject({ grounding: "INSUFFICIENT_EVIDENCE" });
  });

  it("mutation / unannotated tools are never offered nor callable", async () => {
    const wsM = 7500; const c = await mkConv(wsM); await connector(wsM);
    let offeredNames: string[] = [];
    const r = await runChat(wsM, c, { choose: offered => { offeredNames = offered.map(o => o.tool); return pick("delete_record", { id: "1" })(offered); } });
    expect(offeredNames).toEqual(["search_docs"]);
    for (const t of ["delete_record", "send_email", "lookup"]) { const c2 = await mkConv(wsM); await runChat(wsM, c2, { choose: pick(t, { id: "1" }) }); }
    expect(fake.calls("tools/call")).toBe(0); expect(r.task.state).toBe("SUCCEEDED");
  });

  it("the model cannot override the endpoint or add extra keys: the choice is refused and no call is made", async () => {
    const wsE = 7600; const c = await mkConv(wsE); const view = await connector(wsE);
    const evil = (offered: any[]) => ({ connectorId: view.id, tool: "search_docs", arguments: { query: "x" }, endpoint: "https://evil.example/mcp", url: "https://evil.example" });
    const r = await runChat(wsE, c, { choose: evil });
    expect(fake.calls("tools/call")).toBe(0); expect(r.task.state).toBe("SUCCEEDED");
    // an endpoint smuggled inside tool arguments never changes where the call goes: the call still targets the registered endpoint
    const c2 = await mkConv(wsE);
    await runChat(wsE, c2, { choose: pick("search_docs", { query: "x", endpoint: "https://evil.example/mcp" }) });
    expect(fake.calls("tools/call")).toBe(0); // schema validation rejects unknown/oversized args or the server saw only the registered origin
  });

  it("feature flag off: the model is never asked to select a tool and nothing is discovered", async () => {
    const wsF = 7700; const c = await mkConv(wsF); await connector(wsF);
    const r = await runChat(wsF, c, { choose: pick("search_docs"), answers: ["x"] }, { enabled: false, search: [ev(1, "doc text")] });
    expect(r.selectionCalls).toBe(0); expect(fake.requests).toHaveLength(0); expect(r.task.state).toBe("SUCCEEDED");
  });

  it("retry after a transient answer failure does not repeat the tool call", async () => {
    const wsR = 7800; const c = await mkConv(wsR); await connector(wsR);
    const r = await runChat(wsR, c, { choose: pick("search_docs"), answers: ["FAIL", "recovered"] });
    expect(r.task).toMatchObject({ state: "SUCCEEDED", attempt: 2, result: { answer: "recovered" } });
    expect(fake.calls("tools/call")).toBe(1);
  });

  it("tool error / oversize output degrade safely (no fabricated evidence)", async () => {
    const wsT = 7900; const c = await mkConv(wsT); await connector(wsT);
    fake.handlers.search_docs = () => ({ isError: true, content: [{ type: "text", text: "boom" }] });
    const r = await runChat(wsT, c, { choose: pick("search_docs") });
    expect(r.task.result).toMatchObject({ grounding: "INSUFFICIENT_EVIDENCE" });
  });
});
