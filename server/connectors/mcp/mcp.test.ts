import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startFakeMcp, type FakeMcp } from "../../testing/fakeMcpServer";
import { McpClientError, McpReadOnlyClient, validateArguments } from "./client";
import { assertResolvedAddressAllowed, checkEndpointSyntax, decideTool, redactSecrets } from "./policy";

const ENV = { MCP_ALLOWED_ENDPOINTS: "https://mcp.example.com,http://127.0.0.1:1", MCP_ALLOW_LOOPBACK_HTTP: "true" };

describe("endpoint policy", () => {
  it("accepts only operator-approved https origins; http only for loopback when enabled", () => {
    expect(checkEndpointSyntax("https://mcp.example.com/mcp", ENV).ok).toBe(true);
    for (const bad of ["https://evil.example.com/mcp", "http://mcp.example.com/mcp", "ftp://mcp.example.com", "https://user:pw@mcp.example.com/", "https://mcp.example.com/mcp?token=1", "file:///etc/passwd", "not a url", "https://mcp.example.com.evil.com/"]) expect(checkEndpointSyntax(bad, ENV).ok, bad).toBe(false);
    expect(checkEndpointSyntax("http://127.0.0.1:1/mcp", ENV).ok).toBe(true);
    expect(checkEndpointSyntax("http://127.0.0.1:1/mcp", { ...ENV, MCP_ALLOW_LOOPBACK_HTTP: "false" }).ok).toBe(false);
    expect(checkEndpointSyntax("https://mcp.example.com/mcp", {}).ok).toBe(false); // empty allowlist denies everything
  });
  it("refuses link-local/metadata and (by default) private resolved addresses", async () => {
    const lookupTo = (address: string) => (async () => [{ address, family: address.includes(":") ? 6 : 4 }]) as never;
    const url = new URL("https://mcp.example.com/mcp");
    await expect(assertResolvedAddressAllowed(url, ENV, lookupTo("169.254.169.254"))).rejects.toThrow(/link-local|metadata/);
    await expect(assertResolvedAddressAllowed(url, ENV, lookupTo("10.0.0.5"))).rejects.toThrow(/private/);
    await expect(assertResolvedAddressAllowed(url, ENV, lookupTo("fd12::1"))).rejects.toThrow(/private/);
    await expect(assertResolvedAddressAllowed(url, { ...ENV, MCP_ALLOW_PRIVATE_NETWORK: "true" }, lookupTo("10.0.0.5"))).resolves.toBeUndefined();
    await expect(assertResolvedAddressAllowed(url, { ...ENV, MCP_ALLOW_PRIVATE_NETWORK: "true" }, lookupTo("169.254.169.254"))).rejects.toThrow(); // never allowed
    await expect(assertResolvedAddressAllowed(url, ENV, lookupTo("93.184.216.34"))).resolves.toBeUndefined();
    await expect(assertResolvedAddressAllowed(new URL("http://127.0.0.1:1/"), ENV)).resolves.toBeUndefined(); // loopback allowed only with the explicit dev flag
    await expect(assertResolvedAddressAllowed(new URL("http://127.0.0.1:1/"), {})).rejects.toThrow(/private/);
  });
});

describe("tool classification (fail closed)", () => {
  const ro = { readOnlyHint: true };
  it("allows only explicitly read-only, non-mutating-looking tools", () => {
    expect(decideTool({ name: "search_docs", annotations: ro }).allowed).toBe(true);
    expect(decideTool({ name: "getPage", annotations: ro }).allowed).toBe(true);
    expect(decideTool({ name: "list_resources", annotations: ro }).allowed).toBe(true);
  });
  it("denies missing/false readOnlyHint, destructive hints, and mutation-looking names even when labelled read-only", () => {
    expect(decideTool({ name: "lookup" }).allowed).toBe(false);
    expect(decideTool({ name: "lookup", annotations: { readOnlyHint: false } }).allowed).toBe(false);
    expect(decideTool({ name: "lookup", annotations: { readOnlyHint: "true" as never } }).allowed).toBe(false);
    expect(decideTool({ name: "wipe", annotations: { readOnlyHint: true, destructiveHint: true } }).allowed).toBe(false);
    for (const name of ["send_email", "deleteRecord", "create-issue", "run_shell", "updateUser", "git.push", "write_file", "execute", "deploy_app", "pay_invoice", "Set_Flag"]) expect(decideTool({ name, annotations: ro }), name).toMatchObject({ allowed: false });
  });
  it("an operator allowlist narrows further but never widens", () => {
    expect(decideTool({ name: "search_docs", annotations: ro }, ["other"]).allowed).toBe(false);
    expect(decideTool({ name: "search_docs", annotations: ro }, ["search_docs"]).allowed).toBe(true);
    expect(decideTool({ name: "send_email", annotations: ro }, ["send_email"]).allowed).toBe(false);
  });
});

describe("redaction and argument validation", () => {
  it("removes the exact secret and common credential shapes", () => {
    const out = redactSecrets('token=abc123def456 Authorization: Bearer abcdefgh12345678 key sk-abcdefghijklmnop1234 mine SUPERSECRETVALUE', ["SUPERSECRETVALUE"]);
    expect(out).not.toMatch(/abc123def456|abcdefgh12345678|sk-abcdefghijklmnop1234|SUPERSECRETVALUE/);
    expect(redactSecrets("normal text about leave policy")).toBe("normal text about leave policy");
  });
  const schema = { type: "object" as const, properties: { query: { type: "string", maxLength: 5 }, limit: { type: "integer", minimum: 1, maximum: 20 }, mode: { enum: ["a", "b"] } }, required: ["query"], additionalProperties: false };
  it("validates required, types, ranges, enums, unknown keys", () => {
    expect(validateArguments(schema, { query: "abc", limit: 3, mode: "a" })).toEqual([]);
    expect(validateArguments(schema, {})).toContain("missing required argument query");
    expect(validateArguments(schema, { query: 5 })).toContain("query must be string");
    expect(validateArguments(schema, { query: "toolongvalue" })).toContain("query too long");
    expect(validateArguments(schema, { query: "a", limit: 2.5 })).toContain("limit must be an integer");
    expect(validateArguments(schema, { query: "a", limit: 99 })).toContain("limit above maximum");
    expect(validateArguments(schema, { query: "a", mode: "z" })).toContain("mode not an allowed value");
    expect(validateArguments(schema, { query: "a", extra: 1 })).toContain("unknown argument extra");
    expect(validateArguments(schema, null)).toEqual(["arguments must be an object"]);
  });
});

describe("read-only client against the fake MCP server", () => {
  let fake: FakeMcp;
  beforeAll(async () => { fake = await startFakeMcp(); });
  afterAll(async () => { await fake.close(); });
  beforeEach(() => fake.reset());
  const client = (over: Partial<ConstructorParameters<typeof McpReadOnlyClient>[0]> = {}) => new McpReadOnlyClient({ endpoint: fake.url, timeoutMs: 1000, maxResponseBytes: 50_000, ...over });

  it("initialize + tools/list + resources/list; malformed tool entries are counted not trusted", async () => {
    const c = client(); await c.initialize();
    expect(c.serverInfo).toEqual({ name: "fake-mcp", version: "1.2.3" });
    const { tools, malformed } = await c.listTools();
    expect(tools.map(t => t.name)).toEqual(["search_docs", "delete_record", "lookup", "send_email"]);
    expect(malformed).toBe(1);
    expect((await c.listResources()).map(r => r.uri)).toContain("doc://handbook");
  });
  it("speaks only the allowed methods and sends the bearer only when configured", async () => {
    const c = client({ bearer: "tok-123456" }); await c.initialize(); await c.listTools();
    expect(new Set(fake.requests.map(r => r.method))).toEqual(new Set(["initialize", "notifications/initialized", "tools/list"]));
    expect(fake.requests.every(r => r.authorization === "Bearer tok-123456")).toBe(true);
    fake.reset(); const anon = client(); await anon.initialize();
    expect(fake.requests.every(r => r.authorization === undefined)).toBe(true);
  });
  it("parses SSE responses and carries the session id", async () => {
    fake.sse = true; fake.sessionId = "sess-1";
    const c = client(); await c.initialize(); await c.listTools();
    expect(fake.requests.filter(r => r.method === "tools/list")[0].sessionId).toBe("sess-1");
  });
  it("times out slow servers", async () => {
    fake.delayMs = 400;
    await expect(client({ timeoutMs: 100 }).initialize()).rejects.toMatchObject({ kind: "TIMEOUT" });
  });
  it("aborts on responses larger than the bound (Content-Length or streamed)", async () => {
    fake.hugeBytes = 400_000;
    const c = client({ maxResponseBytes: 10_000 }); fake.hugeBytes = 0; await c.initialize(); fake.hugeBytes = 400_000;
    await expect(c.listTools()).rejects.toMatchObject({ kind: "TOO_LARGE" });
  });
  it("maps unreachable servers, HTTP errors, JSON-RPC errors, redirects and malformed results without leaking bodies", async () => {
    await expect(new McpReadOnlyClient({ endpoint: "http://127.0.0.1:1/mcp", timeoutMs: 500, maxResponseBytes: 1000 }).initialize()).rejects.toMatchObject({ kind: "UNAVAILABLE" });
    fake.httpStatus = 500;
    const error = await client().initialize().catch(e => e as McpClientError);
    expect(error).toMatchObject({ kind: "UNAVAILABLE" }); expect(String((error as Error).message)).not.toMatch(/stack trace|secret/);
    fake.reset(); fake.redirectTo = "http://169.254.169.254/latest/meta-data";
    await expect(client().initialize()).rejects.toMatchObject({ kind: "UNAVAILABLE" }); // redirects are never followed
    fake.reset(); fake.initMalformed = true;
    await expect(client().initialize()).rejects.toMatchObject({ kind: "INVALID" });
    fake.reset();
    const c = client(); await c.initialize();
    await expect(c.readResource("doc://missing")).rejects.toMatchObject({ kind: "ERROR" });
  });
});
