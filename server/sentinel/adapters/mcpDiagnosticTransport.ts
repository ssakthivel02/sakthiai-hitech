import { sha256 } from "../engine/canon";
import type { BackendOutcome, ExecOpts, ToolTransport } from "../engine/transport";
import type { WorldObs, WorldRecord } from "../engine/types";
import type { McpActor, NormalizedResult } from "../../connectors/mcp";
import { McpPolicyError } from "../../connectors/mcp";
import type { DiagnosticBinding } from "../types";

type CallTool = (actor: McpActor, connectorId: string, tool: string, args: Record<string, unknown>, opts?: { signal?: AbortSignal }) => Promise<NormalizedResult>;
export interface McpDiagnosticOptions {
  service: { callTool: CallTool };
  workspaceId: number;
  userId?: number;
  /** tenant string the engine expects (tenantOf(workspaceId)); the adapter refuses any other */ tenant: string;
  bindings: readonly DiagnosticBinding[];
  now?: () => number;
}

const MAX_LINES = 200;
const LINE = /^(\d{4}-\d{2}-\d{2}[T ][0-9:.]+(?:Z|[+-]\d{2}:?\d{2})?)\s+([A-Za-z]{3,8})\s+(.*)$/;
const LEVELS = new Set(["TRACE", "DEBUG", "INFO", "NOTICE", "WARN", "WARNING", "ERROR", "ERR", "CRITICAL", "FATAL"]);

/** Turn connector text into evidence-ready records. Structured JSON arrays of {ts,level,text} are honoured; anything else is split by line. */
export function recordsFromText(text: string, retrievedAt: string, truncated: boolean): WorldRecord[] {
  const out: WorldRecord[] = [];
  const t = text.trim();
  if (t.startsWith("[")) {
    try {
      const arr = JSON.parse(t) as unknown;
      if (Array.isArray(arr)) {
        for (const x of arr.slice(0, MAX_LINES)) {
          if (x && typeof x === "object" && typeof (x as { text?: unknown }).text === "string") {
            const o = x as { ts?: unknown; level?: unknown; text: string };
            out.push({ ts: typeof o.ts === "string" ? o.ts : retrievedAt, level: typeof o.level === "string" ? o.level.toUpperCase().slice(0, 16) : "INFO", text: o.text });
          } else if (typeof x === "string") out.push({ ts: retrievedAt, level: "INFO", text: x });
        }
        if (out.length) return withNote(out, truncated, retrievedAt);
      }
    } catch { /* not JSON: fall through to line mode */ }
  }
  for (const raw of t.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (out.length >= MAX_LINES) break;
    const m = LINE.exec(line);
    if (m && LEVELS.has(m[2]!.toUpperCase())) out.push({ ts: m[1]!, level: m[2]!.toUpperCase(), text: m[3]! });
    else out.push({ ts: retrievedAt, level: "INFO", text: line });
  }
  return withNote(out, truncated, retrievedAt);
}
const withNote = (r: WorldRecord[], truncated: boolean, at: string): WorldRecord[] => (truncated && r.length ? [...r, { ts: at, level: "NOTE", text: "[connector output was truncated]" }] : r);

/**
 * Read-only diagnostic adapter over the workspace's MCP connectors. It owns no network code: every call goes through
 * McpConnectorService.callTool, which enforces workspace scoping, enabled connector, discovered tool, read-only decision, argument schema,
 * size/time bounds, secret redaction and audit. This class only maps a Sentinel read tool to a bound MCP tool and normalises the result.
 */
export class McpDiagnosticTransport implements ToolTransport {
  private readonly byTool: Map<string, DiagnosticBinding>;
  private readonly now: () => number;
  constructor(private readonly o: McpDiagnosticOptions) {
    this.byTool = new Map(o.bindings.map((b) => [b.tool, b]));
    this.now = o.now ?? Date.now;
  }

  async exec(tenant: string, tool: string, target: string, opts: ExecOpts = {}): Promise<BackendOutcome> {
    const t0 = this.now();
    const ms = () => Math.max(1, this.now() - t0);
    if (tenant !== this.o.tenant) return { kind: "error", virtual_ms: 1, code: "TENANT_MISMATCH" };
    const b = this.byTool.get(tool);
    if (!b) return { kind: "error", virtual_ms: 1, code: "NO_BINDING" };
    const args: Record<string, unknown> = { ...(b.fixedArgs ?? {}), [b.targetParam]: target };
    const q = opts.args?.["query"]; const w = opts.args?.["window_min"];
    if (b.queryParam && typeof q === "string") args[b.queryParam] = q;
    if (b.windowParam && typeof w === "number") args[b.windowParam] = w;
    if (opts.signal?.aborted) return { kind: "timeout", virtual_ms: 1 };   // the attempt is already over: do not start a connector call nothing will read
    let res: NormalizedResult;
    try {
      res = await this.o.service.callTool({ workspaceId: this.o.workspaceId, ...(this.o.userId ? { userId: this.o.userId } : {}) }, b.connectorId, b.mcpTool, args, ...(opts.signal ? [{ signal: opts.signal }] as const : []));
    } catch (e) {
      if (e instanceof McpPolicyError) {
        if (e.code === "TIMEOUT") return { kind: "timeout", virtual_ms: ms() };
        return { kind: "error", virtual_ms: ms(), code: `MCP_${e.code}` };
      }
      return { kind: "error", virtual_ms: ms(), code: "TRANSPORT_ERROR" };
    }
    if (res.isError) return { kind: "error", virtual_ms: ms(), code: "MCP_TOOL_ERROR" };
    const records = recordsFromText(res.text, res.provenance.retrievedAt, res.truncated);
    const obs: WorldObs[] = records.length ? [{
      obs_id: "o-" + sha256([tenant, tool, target, JSON.stringify(opts.args ?? null), res.provenance.retrievedAt, b.connectorId].join("|")).slice(0, 12),
      tool, target, tenant, source_system: `mcp:${res.provenance.connectorName}`.slice(0, 120), records,
    }] : [];
    return { kind: "ok", obs, virtual_ms: ms() };
  }
}
