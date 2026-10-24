import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDatabase, skipMysqlSuite, type TestDatabase } from "../../testing/mysqlTestDb";
import { startFakeMcp, type FakeMcp } from "../../testing/fakeMcpServer";
import { McpConnectorService, McpConnectorStore, McpPolicyError } from "./index";

const SECRET = "s3cr3t-token-VALUE-9f2a";
const rejectsWith = async (promise: Promise<unknown>, code: string, message?: RegExp) => {
  const error = await promise.then(() => null, e => e as McpPolicyError);
  expect(error, "expected a policy error").toBeInstanceOf(McpPolicyError);
  expect(error!.code).toBe(code); if (message) expect(error!.message).toMatch(message);
};

describe.skipIf(skipMysqlSuite())("governed read-only MCP connector on real SQL", () => {
  let database: TestDatabase; let fake: FakeMcp; let store: McpConnectorStore; let service: McpConnectorService;
  const wsA = { workspaceId: 11, userId: 1 }; const wsB = { workspaceId: 12, userId: 2 };
  let env: Record<string, string | undefined>;
  const rows = async <T = Record<string, any>>(query: ReturnType<typeof sql>) => ((await database.db.execute(query)) as unknown as [T[]])[0];
  let counter = 0;
  const connector = async (over: Partial<Parameters<McpConnectorService["register"]>[1]> & { enable?: boolean; actor?: typeof wsA } = {}) => {
    const { enable = true, actor = wsA, ...input } = over;
    const view = await service.register(actor, { name: `srv-${++counter}`, endpoint: fake.url, ...input });
    if (enable) await service.setEnabled(actor, view.id, true);
    return view;
  };

  beforeAll(async () => {
    database = await createTestDatabase(); fake = await startFakeMcp();
    store = new McpConnectorStore(async () => database.db);
    env = { MCP_ALLOWED_ENDPOINTS: fake.origin, MCP_ALLOW_LOOPBACK_HTTP: "true", MCP_SECRET_FAKE_TOKEN: SECRET };
    service = new McpConnectorService({ store, env });
  });
  afterAll(async () => { await fake?.close(); await database?.close(); });
  beforeEach(() => fake.reset());

  it("registers disabled-by-default connectors only for operator-approved endpoints; secretRef must be a reference", async () => {
    const view = await connector({ enable: false });
    expect(view.enabled).toBe(false);
    await rejectsWith(service.register(wsA, { name: "x1", endpoint: "https://evil.example.com/mcp" }), "DENIED", /allowlist/);
    await rejectsWith(service.register(wsA, { name: "x2", endpoint: fake.url, secretRef: "lowercase-secret-value" }), "INVALID", /reference/);
    await rejectsWith(service.register(wsA, { name: "x3", endpoint: `${fake.origin}/mcp?token=abc` }), "DENIED");
    await rejectsWith(service.register(wsA, { name: "bad name!!", endpoint: fake.url }), "INVALID");
    await rejectsWith(service.register(wsA, { name: view.name, endpoint: fake.url }), "DUPLICATE");
    await rejectsWith(service.discover(wsA, view.id), "DENIED", /disabled/); // explicit enable is required
    expect(fake.requests).toHaveLength(0); // the server was never contacted
  });

  it("capability discovery: allowed read-only tools, denied/malformed reported, resources listed, server identity captured", async () => {
    const view = await connector();
    const found = await service.discover(wsA, view.id);
    expect(found.serverName).toBe("fake-mcp"); expect(found.serverVersion).toBe("1.2.3");
    expect(found.tools.map(t => t.name)).toEqual(["search_docs"]);
    expect(found.deniedTools).toEqual(expect.arrayContaining([
      { name: "delete_record", reason: "tool is declared destructive" },
      { name: "lookup", reason: "tool is not explicitly declared read-only" },
      { name: "send_email", reason: "tool name looks like a mutation" },
    ]));
    expect(found.malformedTools).toBe(1);
    expect(found.resources.map(r => r.uri)).toEqual(["doc://handbook", "doc://binary"]);
    expect(fake.calls("tools/call")).toBe(0);
  });

  it("a server without resources support still discovers tools", async () => {
    const view = await connector(); fake.noResources = true;
    const found = await service.discover(wsA, view.id);
    expect(found.tools).toHaveLength(1); expect(found.resources).toEqual([]);
  });

  it("resource read: normalized text with full provenance; unlisted URIs and binary resources are refused", async () => {
    const view = await connector();
    const result = await service.readResource(wsA, view.id, "doc://handbook");
    expect(result).toMatchObject({ kind: "resource", text: "Annual leave is 25 days.", isError: false, truncated: false });
    expect(result.provenance).toMatchObject({ connectorId: view.id, connectorName: view.name, serverName: "fake-mcp", serverVersion: "1.2.3", endpointOrigin: fake.origin, kind: "resource", name: "doc://handbook" });
    expect(new Date(result.provenance.retrievedAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
    await rejectsWith(service.readResource(wsA, view.id, "file:///etc/passwd"), "DENIED", /not exposed/);
    await rejectsWith(service.readResource(wsA, view.id, "doc://binary"), "INVALID", /no text/);
    expect(fake.requests.filter(r => r.method === "resources/read").map(r => r.params.uri)).toEqual(["doc://handbook", "doc://binary"]); // file:// never reached the server
  });

  it("allowed read-only tool runs with validated arguments and provenance", async () => {
    const view = await connector();
    const result = await service.callTool(wsA, view.id, "search_docs", { query: "leave", limit: 3 });
    expect(result).toMatchObject({ kind: "tool", text: "results for leave", isError: false });
    expect(result.provenance).toMatchObject({ kind: "tool", name: "search_docs", connectorName: view.name });
    await rejectsWith(service.callTool(wsA, view.id, "search_docs", { limit: 3 }), "INVALID", /missing required/);
    await rejectsWith(service.callTool(wsA, view.id, "search_docs", { query: "x", limit: 999 }), "INVALID", /above maximum/);
    await rejectsWith(service.callTool(wsA, view.id, "search_docs", { query: "x", evil: 1 }), "INVALID", /unknown argument/);
    expect(fake.calls("tools/call")).toBe(1); // invalid calls never reached the server
  });

  it("mutation / unannotated / unlisted tools are denied BEFORE any tools/call is sent", async () => {
    const view = await connector();
    fake.handlers.delete_record = () => { throw new Error("must never run"); }; fake.handlers.send_email = () => { throw new Error("must never run"); };
    for (const tool of ["delete_record", "send_email", "lookup", "no_such_tool", "broken_tool"]) await rejectsWith(service.callTool(wsA, view.id, tool, { id: "1" }), "DENIED");
    expect(fake.calls("tools/call")).toBe(0);
  });

  it("an operator allowlist on the connector narrows the callable tools", async () => {
    const view = await connector({ allowedTools: ["something_else"] });
    expect((await service.discover(wsA, view.id)).tools).toEqual([]);
    await rejectsWith(service.callTool(wsA, view.id, "search_docs", { query: "x" }), "DENIED", /allowlist/);
  });

  it("timeouts, oversize responses and unavailable servers fail safely with generic errors and audit rows", async () => {
    const slow = await connector({ timeoutMs: 500 }); fake.delayMs = 800;
    await rejectsWith(service.discover(wsA, slow.id), "TIMEOUT");
    fake.reset();
    const small = await connector({ maxResponseBytes: 2048 });
    await service.discover(wsA, small.id); fake.hugeBytes = 100_000;
    await rejectsWith(service.callTool(wsA, small.id, "search_docs", { query: "x" }), "TOO_LARGE");
    fake.reset(); fake.httpStatus = 503;
    const down = await connector();
    const error = await service.discover(wsA, down.id).catch(e => e as McpPolicyError);
    expect(error).toMatchObject({ code: "UNAVAILABLE" }); expect(error.message).not.toMatch(/stack trace|secret/i);
    const audited = await rows<{ outcome: string }>(sql`SELECT outcome FROM mcpConnectorAudit WHERE workspaceId = ${wsA.workspaceId} AND outcome IN ('TIMEOUT','TOO_LARGE','ERROR')`);
    expect(new Set(audited.map(r => r.outcome))).toEqual(new Set(["TIMEOUT", "TOO_LARGE", "ERROR"]));
  });

  it("a completely unreachable endpoint (port closed) is UNAVAILABLE", async () => {
    const closedEnv = { ...env, MCP_ALLOWED_ENDPOINTS: "http://127.0.0.1:1" };
    const svc = new McpConnectorService({ store, env: closedEnv });
    const view = await svc.register(wsA, { name: `closed-${++counter}`, endpoint: "http://127.0.0.1:1/mcp", timeoutMs: 800 });
    await svc.setEnabled(wsA, view.id, true);
    await rejectsWith(svc.discover(wsA, view.id), "UNAVAILABLE");
  });

  it("workspace isolation: another workspace cannot see, enable, discover, read, call or remove a connector (NOT_FOUND), lists are separate", async () => {
    const mine = await connector();
    await rejectsWith(service.discover(wsB, mine.id), "NOT_FOUND");
    await rejectsWith(service.readResource(wsB, mine.id, "doc://handbook"), "NOT_FOUND");
    await rejectsWith(service.callTool(wsB, mine.id, "search_docs", { query: "x" }), "NOT_FOUND");
    await rejectsWith(service.setEnabled(wsB, mine.id, false), "NOT_FOUND");
    await rejectsWith(service.remove(wsB, mine.id), "NOT_FOUND");
    expect((await service.list(wsB.workspaceId)).map(c => c.id)).not.toContain(mine.id);
    expect((await service.list(wsA.workspaceId)).map(c => c.id)).toContain(mine.id);
    const same = await connector({ actor: wsB, name: "same-name-different-workspace" });
    expect(same.id).not.toBe(mine.id);
    expect(fake.requests).toHaveLength(0);
    const mineAfter = (await service.list(wsA.workspaceId)).find(c => c.id === mine.id)!;
    expect(mineAfter.enabled).toBe(true);
  });

  it("secrets: sent only as the bearer, resolved server-side, redacted from tool output/descriptions, never in views, audit rows or errors", async () => {
    const view = await connector({ secretRef: "FAKE_TOKEN" });
    expect(JSON.stringify(view)).not.toContain(SECRET); expect(view.hasSecret).toBe(true);
    fake.handlers.search_docs = () => ({ content: [{ type: "text", text: `leaked ${SECRET} and Authorization: Bearer ${SECRET} and api_key=abcdef123456` }] });
    (fake.tools[0] as any).description = `uses secret ${SECRET}`;
    const found = await service.discover(wsA, view.id);
    expect(JSON.stringify(found)).not.toContain(SECRET);
    const result = await service.callTool(wsA, view.id, "search_docs", { query: "x" });
    expect(result.text).not.toMatch(new RegExp(`${SECRET}|abcdef123456`)); expect(result.text).toContain("[REDACTED]");
    expect(fake.requests.every(r => r.authorization === `Bearer ${SECRET}`)).toBe(true);
    expect(JSON.stringify(await rows(sql`SELECT * FROM mcpConnectorAudit`))).not.toContain(SECRET);
    expect(JSON.stringify(await rows(sql`SELECT * FROM mcpConnectors`))).not.toContain(SECRET);
    // missing server-side secret: refused without contacting the server
    const orphan = await connector({ secretRef: "NOT_CONFIGURED" }); fake.requests.length = 0;
    await rejectsWith(service.discover(wsA, orphan.id), "UNAVAILABLE", /secret is not configured/);
    expect(fake.requests).toHaveLength(0);
  });

  it("output is bounded: very long tool text is truncated and marked", async () => {
    const view = await connector({ maxResponseBytes: 2_000_000 });
    fake.handlers.search_docs = () => ({ content: [{ type: "text", text: "y".repeat(100_000) }, { type: "image", data: "AAAA", mimeType: "image/png" }] });
    const result = await service.callTool(wsA, view.id, "search_docs", { query: "x" });
    expect(result.text.length).toBe(32_000); expect(result.truncated).toBe(true); expect(result.ignoredNonTextParts).toBe(1); expect(result.provenance.truncated).toBe(true);
  });

  it("tool-reported errors are surfaced as isError results and audited as ERROR", async () => {
    const view = await connector();
    fake.handlers.search_docs = () => ({ isError: true, content: [{ type: "text", text: "backend exploded" }] });
    const result = await service.callTool(wsA, view.id, "search_docs", { query: "x" });
    expect(result.isError).toBe(true);
    const [last] = await rows<{ outcome: string }>(sql`SELECT outcome FROM mcpConnectorAudit WHERE connectorId = ${view.id} AND action = 'CALL_TOOL' ORDER BY id DESC LIMIT 1`);
    expect(last.outcome).toBe("ERROR");
  });

  it("the allowlist is enforced again at call time: removing the origin from configuration disables a registered connector", async () => {
    const view = await connector();
    const locked = new McpConnectorService({ store, env: { ...env, MCP_ALLOWED_ENDPOINTS: "https://other.example.com" } });
    await rejectsWith(locked.discover(wsA, view.id), "DENIED", /allowlist/);
    await rejectsWith(locked.setEnabled(wsA, view.id, true), "DENIED");
    expect(fake.requests).toHaveLength(0);
  });

  it("every operation leaves an audit record naming actor, action, target and outcome (including denials)", async () => {
    const view = await connector();
    await service.readResource(wsA, view.id, "doc://handbook");
    await service.callTool(wsA, view.id, "search_docs", { query: "q" });
    await service.callTool(wsA, view.id, "send_email", {}).catch(() => undefined);
    const audit = await store.listAudit(wsA.workspaceId, 20);
    const mine = audit.filter(a => a.connectorId === view.id).map(a => `${a.action}:${a.target}:${a.outcome}`);
    expect(mine).toEqual(expect.arrayContaining(["REGISTER:" + view.name + ":OK", "ENABLE:null:OK", "READ_RESOURCE:doc://handbook:OK", "CALL_TOOL:search_docs:OK", "CALL_TOOL:send_email:DENIED"]));
    expect(audit.every(a => a.workspaceId === wsA.workspaceId)).toBe(true);
    expect(audit.find(a => a.action === "CALL_TOOL" && a.target === "search_docs")!.actorUserId).toBe(wsA.userId);
  });

  it("if the audit record cannot be written the result is withheld (fail closed)", async () => {
    const view = await connector();
    const broken = new McpConnectorStore(async () => database.db);
    broken.audit = async () => { throw new Error("audit sink down"); };
    const svc = new McpConnectorService({ store: broken, env });
    await expect(svc.readResource(wsA, view.id, "doc://handbook")).rejects.toThrow(/audit sink down/);
  });

  it("database unavailable: operations reject", async () => {
    const svc = new McpConnectorService({ store: new McpConnectorStore(async () => null), env });
    await expect(svc.list(1)).rejects.toThrow(/unavailable/);
    await expect(svc.discover(wsA, "00000000-0000-4000-8000-000000000000")).rejects.toThrow(/unavailable/);
  });
});
