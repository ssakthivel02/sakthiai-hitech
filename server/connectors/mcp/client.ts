import { z } from "zod";

/**
 * Minimal MCP (Streamable HTTP, JSON-RPC 2.0) READ-ONLY client. It speaks only: initialize, tools/list, tools/call,
 * resources/list, resources/read. Bounded in time and bytes, never follows redirects, validates every server payload,
 * and never puts response bodies or credentials into error messages.
 */
export class McpClientError extends Error {
  constructor(readonly kind: "TIMEOUT" | "TOO_LARGE" | "INVALID" | "ERROR" | "UNAVAILABLE", message: string) { super(message); this.name = "McpClientError"; }
}

export type McpClientConfig = {
  endpoint: string;
  timeoutMs: number;
  maxResponseBytes: number;
  bearer?: string;
  fetchImpl?: typeof fetch;
};

const PROTOCOL_VERSION = "2025-03-26";

const toolSchema = z.object({
  name: z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/),
  description: z.string().max(4000).optional(),
  inputSchema: z.object({ type: z.literal("object"), properties: z.record(z.string(), z.unknown()).optional(), required: z.array(z.string()).optional() }).passthrough(),
  annotations: z.object({ readOnlyHint: z.boolean().optional(), destructiveHint: z.boolean().optional(), idempotentHint: z.boolean().optional() }).passthrough().optional(),
}).passthrough();
export type McpTool = z.infer<typeof toolSchema>;

const resourceSchema = z.object({ uri: z.string().min(1).max(2048), name: z.string().max(256).optional(), description: z.string().max(2000).optional(), mimeType: z.string().max(128).optional() }).passthrough();
export type McpResource = z.infer<typeof resourceSchema>;

const textContent = z.object({ type: z.literal("text"), text: z.string() }).passthrough();
const callResultSchema = z.object({ content: z.array(z.union([textContent, z.object({ type: z.string() }).passthrough()])), isError: z.boolean().optional() }).passthrough();
const readResultSchema = z.object({ contents: z.array(z.object({ uri: z.string(), mimeType: z.string().optional(), text: z.string().optional(), blob: z.string().optional() }).passthrough()) }).passthrough();
const initSchema = z.object({ protocolVersion: z.string().optional(), serverInfo: z.object({ name: z.string().max(128), version: z.string().max(64).optional() }).partial().optional() }).passthrough();

async function readBounded(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > maxBytes) { await response.body?.cancel().catch(() => undefined); throw new McpClientError("TOO_LARGE", "server response exceeds the size limit"); }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) { await reader.cancel().catch(() => undefined); throw new McpClientError("TOO_LARGE", "server response exceeds the size limit"); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseRpc(contentType: string, body: string, id: number): { result?: unknown; error?: { code?: number; message?: string } } {
  let candidates: string[];
  if (contentType.includes("text/event-stream")) {
    candidates = body.split(/\r?\n\r?\n/).map(evt => evt.split(/\r?\n/).filter(l => l.startsWith("data:")).map(l => l.slice(5).trimStart()).join("\n")).filter(Boolean);
  } else candidates = [body];
  for (const text of candidates) {
    let value: unknown;
    try { value = JSON.parse(text); } catch { continue; }
    const messages = Array.isArray(value) ? value : [value];
    for (const m of messages) if (m && typeof m === "object" && (m as { id?: unknown }).id === id) return m as never;
  }
  throw new McpClientError("INVALID", "server returned no valid JSON-RPC response");
}

export class McpReadOnlyClient {
  private nextId = 1;
  private sessionId: string | null = null;
  private bytes = 0;
  serverInfo: { name?: string; version?: string } = {};
  constructor(private readonly config: McpClientConfig) {}
  get responseBytes() { return this.bytes; }

  private async post(payload: unknown, expectId?: number): Promise<{ result?: unknown; error?: { code?: number; message?: string } } | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await (this.config.fetchImpl ?? fetch)(this.config.endpoint, {
        method: "POST", redirect: "error", signal: controller.signal,
        headers: {
          "content-type": "application/json", accept: "application/json, text/event-stream",
          ...(this.config.bearer ? { authorization: `Bearer ${this.config.bearer}` } : {}),
          ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
        },
        body: JSON.stringify(payload),
      });
      const session = response.headers.get("mcp-session-id");
      if (session && /^[\x21-\x7e]{1,256}$/.test(session)) this.sessionId = session;
      if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new McpClientError("UNAVAILABLE", `server answered HTTP ${response.status}`); }
      if (expectId === undefined) { await response.body?.cancel().catch(() => undefined); return null; }
      const text = await readBounded(response, this.config.maxResponseBytes);
      this.bytes += Buffer.byteLength(text, "utf8");
      return parseRpc(response.headers.get("content-type") ?? "", text, expectId);
    } catch (error) {
      if (error instanceof McpClientError) throw error;
      if ((error as { name?: string })?.name === "AbortError") throw new McpClientError("TIMEOUT", "server did not answer in time");
      throw new McpClientError("UNAVAILABLE", "server unreachable");
    } finally { clearTimeout(timer); }
  }

  private async rpc<T>(method: string, params: unknown, schema: z.ZodType<T>): Promise<T> {
    const id = this.nextId++;
    const reply = await this.post({ jsonrpc: "2.0", id, method, params }, id);
    if (!reply || reply.error) throw new McpClientError("ERROR", `server rejected ${method}${reply?.error?.code !== undefined ? ` (code ${reply.error.code})` : ""}`);
    const parsed = schema.safeParse(reply.result);
    if (!parsed.success) throw new McpClientError("INVALID", `server returned a malformed ${method} result`);
    return parsed.data;
  }

  async initialize(): Promise<void> {
    const init = await this.rpc("initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "sakthiai-readonly-connector", version: "1" } }, initSchema);
    this.serverInfo = { name: init.serverInfo?.name, version: init.serverInfo?.version };
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" }).catch(() => undefined);
  }

  /** Malformed tool entries are reported, not trusted; one bad tool does not poison the rest. */
  async listTools(): Promise<{ tools: McpTool[]; malformed: number }> {
    const result = await this.rpc("tools/list", {}, z.object({ tools: z.array(z.unknown()) }).passthrough());
    const tools: McpTool[] = []; let malformed = 0;
    for (const entry of result.tools.slice(0, 500)) { const parsed = toolSchema.safeParse(entry); if (parsed.success) tools.push(parsed.data); else malformed += 1; }
    return { tools, malformed };
  }
  async listResources(): Promise<McpResource[]> {
    const result = await this.rpc("resources/list", {}, z.object({ resources: z.array(z.unknown()) }).passthrough());
    return result.resources.slice(0, 500).flatMap(entry => { const p = resourceSchema.safeParse(entry); return p.success ? [p.data] : []; });
  }
  callTool(name: string, args: Record<string, unknown>) { return this.rpc("tools/call", { name, arguments: args }, callResultSchema); }
  readResource(uri: string) { return this.rpc("resources/read", { uri }, readResultSchema); }
}

/** Validates tool arguments against the SERVER-declared inputSchema subset (type/required/enum/length/range/items). Returns problems. */
export function validateArguments(schema: McpTool["inputSchema"], args: unknown): string[] {
  const problems: string[] = [];
  if (!args || typeof args !== "object" || Array.isArray(args)) return ["arguments must be an object"];
  const input = args as Record<string, unknown>;
  const props = (schema.properties ?? {}) as Record<string, any>;
  for (const key of schema.required ?? []) if (!(key in input)) problems.push(`missing required argument ${key}`);
  if ((schema as { additionalProperties?: unknown }).additionalProperties === false) for (const key of Object.keys(input)) if (!(key in props)) problems.push(`unknown argument ${key}`);
  const check = (value: unknown, def: any, path: string) => {
    if (!def || typeof def !== "object") return;
    const t = def.type;
    const kind = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
    if (t === "integer") { if (typeof value !== "number" || !Number.isInteger(value)) problems.push(`${path} must be an integer`); }
    else if (t === "number") { if (typeof value !== "number" || !Number.isFinite(value)) problems.push(`${path} must be a number`); }
    else if (t && t !== kind) { problems.push(`${path} must be ${t}`); return; }
    if (typeof value === "string") { if (typeof def.maxLength === "number" && value.length > def.maxLength) problems.push(`${path} too long`); if (typeof def.minLength === "number" && value.length < def.minLength) problems.push(`${path} too short`); }
    if (typeof value === "number") { if (typeof def.minimum === "number" && value < def.minimum) problems.push(`${path} below minimum`); if (typeof def.maximum === "number" && value > def.maximum) problems.push(`${path} above maximum`); }
    if (Array.isArray(def.enum) && !def.enum.includes(value)) problems.push(`${path} not an allowed value`);
    if (Array.isArray(value) && def.items) value.slice(0, 200).forEach((v, i) => check(v, def.items, `${path}[${i}]`));
  };
  for (const [key, value] of Object.entries(input)) if (key in props) check(value, props[key], key);
  return problems;
}
