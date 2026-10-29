import http from "node:http";
import type { AddressInfo } from "node:net";

/** Deterministic fake MCP server (Streamable HTTP, JSON-RPC 2.0) with switchable misbehaviour. Loopback only. */
export type FakeTool = { name: string; description?: string; inputSchema?: unknown; annotations?: Record<string, unknown>; handler?: (args: any) => unknown };
export type FakeMcp = {
  url: string; origin: string; port: number;
  tools: unknown[]; resources: Array<{ uri: string; name?: string; mimeType?: string }>; contents: Record<string, unknown[]>;
  handlers: Record<string, (args: any) => unknown>;
  requests: Array<{ method: string; authorization?: string; sessionId?: string; params?: any }>;
  delayMs: number; httpStatus: number | null; hugeBytes: number; sse: boolean; initMalformed: boolean; redirectTo: string | null; sessionId: string | null; noResources: boolean;
  calls(method: string): number;
  reset(): void; close(): Promise<void>;
};

const defaultTools = (): unknown[] => [
  { name: "search_docs", description: "Search documentation", inputSchema: { type: "object", properties: { query: { type: "string", maxLength: 200 }, limit: { type: "integer", minimum: 1, maximum: 20 } }, required: ["query"], additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: "delete_record", description: "Delete a record", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] }, annotations: { readOnlyHint: false, destructiveHint: true } },
  { name: "lookup", description: "Mislabelled: no annotations at all", inputSchema: { type: "object" } },
  { name: "send_email", description: "Claims read-only but is a mutation by name", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
  { name: "broken_tool", description: "malformed schema", inputSchema: "not-an-object" },
];

export async function startFakeMcp(): Promise<FakeMcp> {
  const fake: FakeMcp = {
    url: "", origin: "", port: 0, tools: defaultTools(), resources: [{ uri: "doc://handbook", name: "Handbook", mimeType: "text/plain" }, { uri: "doc://binary", name: "Binary" }],
    contents: { "doc://handbook": [{ uri: "doc://handbook", mimeType: "text/plain", text: "Annual leave is 25 days." }], "doc://binary": [{ uri: "doc://binary", blob: "AAEC" }] },
    handlers: { search_docs: args => ({ content: [{ type: "text", text: `results for ${args.query}` }] }) },
    requests: [], delayMs: 0, httpStatus: null, hugeBytes: 0, sse: false, initMalformed: false, redirectTo: null, sessionId: null, noResources: false,
    calls: m => fake.requests.filter(r => r.method === m).length,
    reset() { fake.tools = defaultTools(); fake.requests = []; fake.delayMs = 0; fake.httpStatus = null; fake.hugeBytes = 0; fake.sse = false; fake.initMalformed = false; fake.redirectTo = null; fake.sessionId = null; fake.noResources = false; fake.handlers = { search_docs: args => ({ content: [{ type: "text", text: `results for ${args.query}` }] }) }; },
    async close() { server.closeAllConnections(); await new Promise(r => server.close(r)); },
  };
  const server = http.createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on("data", c => parts.push(c));
    req.on("end", async () => {
      let body: any; try { body = JSON.parse(Buffer.concat(parts).toString("utf8")); } catch { res.writeHead(400); return res.end(); }
      fake.requests.push({ method: body.method, authorization: req.headers.authorization, sessionId: req.headers["mcp-session-id"] as string | undefined, params: body.params });
      if (fake.delayMs) await new Promise(r => setTimeout(r, fake.delayMs));
      if (fake.redirectTo) { res.writeHead(302, { location: fake.redirectTo }); return res.end(); }
      if (fake.httpStatus) { res.writeHead(fake.httpStatus); return res.end("internal secret stack trace"); }
      if (body.id === undefined) { res.writeHead(202); return res.end(); }
      const reply = (result: unknown, error?: unknown) => {
        const payload = JSON.stringify(error ? { jsonrpc: "2.0", id: body.id, error } : { jsonrpc: "2.0", id: body.id, result });
        const headers: Record<string, string> = { ...(fake.sessionId ? { "mcp-session-id": fake.sessionId } : {}) };
        if (fake.sse) { res.writeHead(200, { ...headers, "content-type": "text/event-stream" }); return res.end(`event: message\ndata: ${payload}\n\n`); }
        res.writeHead(200, { ...headers, "content-type": "application/json" }); res.end(payload);
      };
      if (fake.hugeBytes && body.method !== "initialize") return reply({ tools: [], resources: [], content: [{ type: "text", text: "x".repeat(fake.hugeBytes) }], contents: [{ uri: "doc://handbook", text: "x".repeat(fake.hugeBytes) }] });
      switch (body.method) {
        case "initialize": return fake.initMalformed ? reply({ nope: true, protocolVersion: 5 }) : reply({ protocolVersion: "2025-03-26", capabilities: { tools: {}, resources: {} }, serverInfo: { name: "fake-mcp", version: "1.2.3" } });
        case "tools/list": return reply({ tools: fake.tools });
        case "resources/list": return fake.noResources ? reply(undefined, { code: -32601, message: "Method not found" }) : reply({ resources: fake.resources });
        case "resources/read": { const c = fake.contents[body.params?.uri]; return c ? reply({ contents: c }) : reply(undefined, { code: -32002, message: "Resource not found" }); }
        case "tools/call": { const h = fake.handlers[body.params?.name]; return h ? reply(h(body.params.arguments ?? {})) : reply(undefined, { code: -32602, message: "Unknown tool" }); }
        default: return reply(undefined, { code: -32601, message: "Method not found" });
      }
    });
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  fake.port = (server.address() as AddressInfo).port;
  fake.origin = `http://127.0.0.1:${fake.port}`;
  fake.url = `${fake.origin}/mcp`;
  return fake;
}
