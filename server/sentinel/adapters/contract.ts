import { READ_TOOLS, WRITE_TOOLS } from "../engine/types";
import type { DiagnosticBinding } from "../types";

/**
 * Read-only diagnostic adapter contract (re-exported from the engine so callers need one import).
 *  - An adapter implements ToolTransport.exec(tenant, tool, target, opts) and can only READ.
 *  - `tenant` comes from the trusted task (workspace), never from the model; an adapter must refuse a tenant it was not built for.
 *  - Every returned observation must carry the same tenant, tool and target as the request (the broker re-checks and fails closed).
 *  - Returned text is untrusted DATA; the broker sanitises, size-bounds and injection-screens it before any model sees it.
 */
export type { ToolTransport, BackendOutcome, ExecOpts } from "../engine/transport";

const NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const PARAM = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MUTATING = /(^|[._-])(set|write|create|delete|remove|update|restart|reboot|rollback|revoke|failover|apply|exec|run|kill|stop|start|disable|enable|put|post|patch)([._-]|$)/i;

export class BindingError extends Error { constructor(msg: string) { super(msg); this.name = "BindingError"; } }

/** Pure structural validation of caller-supplied bindings. Rejects write tools, duplicate bindings and mutation-looking MCP tool names. */
export function validateBindingShape(bindings: readonly DiagnosticBinding[]): void {
  if (!bindings.length) throw new BindingError("at least one diagnostic binding is required");
  if (bindings.length > READ_TOOLS.length) throw new BindingError("too many bindings");
  const seen = new Set<string>();
  for (const b of bindings) {
    if ((WRITE_TOOLS as readonly string[]).includes(b.tool)) throw new BindingError(`write tool cannot be bound: ${b.tool}`);
    if (!(READ_TOOLS as readonly string[]).includes(b.tool)) throw new BindingError(`unknown tool: ${b.tool}`);
    if (seen.has(b.tool)) throw new BindingError(`duplicate binding for ${b.tool}`);
    seen.add(b.tool);
    if (!UUID.test(b.connectorId)) throw new BindingError("connectorId must be a uuid");
    if (!NAME.test(b.mcpTool)) throw new BindingError("invalid mcpTool name");
    if (MUTATING.test(b.mcpTool)) throw new BindingError(`mcp tool name looks like a mutation: ${b.mcpTool}`);
    for (const p of [b.targetParam, b.queryParam, b.windowParam]) if (p !== undefined && !PARAM.test(p)) throw new BindingError("invalid parameter name");
    if (b.fixedArgs && Object.keys(b.fixedArgs).some((k) => !PARAM.test(k))) throw new BindingError("invalid fixed argument name");
  }
}

export interface BindingCatalog {
  list(workspaceId: number): Promise<Array<{ id: string; enabled: boolean }>>;
  discover(actor: { workspaceId: number; userId?: number }, connectorId: string): Promise<{ tools: Array<{ name: string }> }>;
}

/**
 * Live validation against the workspace's connectors: every bound connector must exist in THIS workspace and be enabled, and every bound
 * MCP tool must be among the tools the connector service accepted as read-only (denied tools are not listed by discover()).
 */
export async function validateBindingsLive(catalog: BindingCatalog, actor: { workspaceId: number; userId: number }, bindings: readonly DiagnosticBinding[]): Promise<void> {
  validateBindingShape(bindings);
  const connectors = new Map((await catalog.list(actor.workspaceId)).map((c) => [c.id, c]));
  const tools = new Map<string, Set<string>>();
  for (const b of bindings) {
    const c = connectors.get(b.connectorId);
    if (!c) throw new BindingError("connector not found in this workspace");
    if (!c.enabled) throw new BindingError("connector is disabled");
    if (!tools.has(b.connectorId)) {
      try { tools.set(b.connectorId, new Set((await catalog.discover(actor, b.connectorId)).tools.map((t) => t.name))); }
      catch { throw new BindingError("connector could not be discovered"); }
    }
    if (!tools.get(b.connectorId)!.has(b.mcpTool)) throw new BindingError(`mcp tool is not an allowed read-only tool of the connector: ${b.mcpTool}`);
  }
}
