import dns from "node:dns/promises";
import { assertResolvedAddressAllowed, checkEndpointSyntax, decideTool, redactSecrets, type EnvLike } from "./policy";
import { McpClientError, McpReadOnlyClient, validateArguments, type McpTool } from "./client";
import type { AuditAction, AuditOutcome, ConnectorRecord, McpConnectorStore } from "./store";

/**
 * Governed READ-ONLY MCP runtime. Every operation: workspace-scoped lookup -> enabled check -> endpoint re-validation
 * against the operator allowlist and resolved address -> server-side secret resolution -> bounded client call ->
 * schema validation -> redaction -> provenance -> audit row (audit failure withholds the result: fail closed).
 * The model/agent can name only a connector id, a discovered tool and arguments; it can never supply a URL, command or path.
 */
export class McpPolicyError extends Error {
  constructor(readonly code: "DENIED" | "NOT_FOUND" | "INVALID" | "UNAVAILABLE" | "TIMEOUT" | "TOO_LARGE" | "DUPLICATE", message: string) { super(message); this.name = "McpPolicyError"; }
}

export type McpActor = { workspaceId: number; userId?: number };
export type Provenance = { connectorId: string; connectorName: string; serverName: string | null; serverVersion: string | null; endpointOrigin: string; kind: "tool" | "resource"; name: string; retrievedAt: string; responseBytes: number; truncated: boolean };
export type NormalizedResult = { kind: "tool" | "resource"; text: string; isError: boolean; truncated: boolean; ignoredNonTextParts: number; provenance: Provenance };
export type DiscoveryResult = {
  serverName: string | null; serverVersion: string | null;
  tools: Array<{ name: string; description?: string; inputSchema: McpTool["inputSchema"] }>;
  deniedTools: Array<{ name: string; reason: string }>;
  malformedTools: number;
  resources: Array<{ uri: string; name?: string; mimeType?: string }>;
};
export type ConnectorView = { id: string; name: string; endpoint: string; enabled: boolean; hasSecret: boolean; allowedTools: string[] | null; timeoutMs: number; maxResponseBytes: number };

const MAX_MODEL_TEXT_CHARS = 32_000;
const MAX_ARGS_BYTES = 16_000;
const NAME = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,95}$/;
const SECRET_REF = /^[A-Z][A-Z0-9_]{0,63}$/;
const OUTCOME_BY_KIND: Record<string, AuditOutcome> = { TIMEOUT: "TIMEOUT", TOO_LARGE: "TOO_LARGE", INVALID: "INVALID", ERROR: "ERROR", UNAVAILABLE: "ERROR" };
const POLICY_CODE: Record<string, McpPolicyError["code"]> = { TIMEOUT: "TIMEOUT", TOO_LARGE: "TOO_LARGE", INVALID: "INVALID", ERROR: "UNAVAILABLE", UNAVAILABLE: "UNAVAILABLE" };

export type ServiceDeps = { store: McpConnectorStore; env?: EnvLike; fetchImpl?: typeof fetch; lookup?: typeof dns.lookup };

export class McpConnectorService {
  private readonly env: EnvLike;
  constructor(private readonly deps: ServiceDeps) { this.env = deps.env ?? process.env; }

  private view = (c: ConnectorRecord): ConnectorView => ({ id: c.id, name: c.name, endpoint: c.endpoint, enabled: c.enabled, hasSecret: !!c.secretRef, allowedTools: c.allowedTools, timeoutMs: c.timeoutMs, maxResponseBytes: c.maxResponseBytes });
  private secretOf = (c: ConnectorRecord): string | undefined => (c.secretRef ? this.env[`MCP_SECRET_${c.secretRef}`] : undefined);

  async register(actor: McpActor, input: { name: string; endpoint: string; secretRef?: string; allowedTools?: string[]; timeoutMs?: number; maxResponseBytes?: number }): Promise<ConnectorView> {
    if (!NAME.test(input.name)) throw new McpPolicyError("INVALID", "invalid connector name");
    if (input.secretRef !== undefined && !SECRET_REF.test(input.secretRef)) throw new McpPolicyError("INVALID", "secretRef must be a reference name like MY_SERVER_TOKEN, never a secret value");
    const verdict = checkEndpointSyntax(input.endpoint, this.env);
    if (!verdict.ok) throw new McpPolicyError("DENIED", verdict.reason);
    const timeoutMs = Math.min(30_000, Math.max(500, Math.floor(input.timeoutMs ?? 8000)));
    const maxResponseBytes = Math.min(2_000_000, Math.max(1024, Math.floor(input.maxResponseBytes ?? 262_144)));
    const created = await this.deps.store.create({ workspaceId: actor.workspaceId, name: input.name, endpoint: verdict.url.toString(), secretRef: input.secretRef, allowedTools: input.allowedTools?.slice(0, 100), timeoutMs, maxResponseBytes, createdByUserId: actor.userId });
    if (created === "DUPLICATE_NAME") throw new McpPolicyError("DUPLICATE", "a connector with this name already exists");
    await this.deps.store.audit({ workspaceId: actor.workspaceId, connectorId: created.id, actorUserId: actor.userId, action: "REGISTER", target: created.name, outcome: "OK" });
    return this.view(created);
  }

  async list(workspaceId: number): Promise<ConnectorView[]> { return (await this.deps.store.list(workspaceId)).map(this.view); }

  async setEnabled(actor: McpActor, id: string, enabled: boolean): Promise<void> {
    const connector = await this.deps.store.get(actor.workspaceId, id);
    if (!connector) throw new McpPolicyError("NOT_FOUND", "connector not found");
    if (enabled) { const verdict = checkEndpointSyntax(connector.endpoint, this.env); if (!verdict.ok) throw new McpPolicyError("DENIED", verdict.reason); }
    await this.deps.store.setEnabled(actor.workspaceId, id, enabled);
    await this.deps.store.audit({ workspaceId: actor.workspaceId, connectorId: id, actorUserId: actor.userId, action: enabled ? "ENABLE" : "DISABLE", outcome: "OK" });
  }

  async remove(actor: McpActor, id: string): Promise<void> {
    if (!(await this.deps.store.remove(actor.workspaceId, id))) throw new McpPolicyError("NOT_FOUND", "connector not found");
    await this.deps.store.audit({ workspaceId: actor.workspaceId, connectorId: id, actorUserId: actor.userId, action: "REMOVE", outcome: "OK" });
  }

  /** Common gate + client construction. Records DENIED audits for refusals. */
  private async open(actor: McpActor, id: string, action: AuditAction, target?: string): Promise<{ connector: ConnectorRecord; client: McpReadOnlyClient; secret: string | undefined }> {
    const connector = await this.deps.store.get(actor.workspaceId, id);
    if (!connector) throw new McpPolicyError("NOT_FOUND", "connector not found"); // another workspace's id is indistinguishable from absent
    const deny = async (detail: string, code: McpPolicyError["code"] = "DENIED"): Promise<never> => {
      await this.deps.store.audit({ workspaceId: actor.workspaceId, connectorId: id, actorUserId: actor.userId, action, target, outcome: "DENIED", detail });
      throw new McpPolicyError(code, detail);
    };
    if (!connector.enabled) return deny("connector is disabled");
    const verdict = checkEndpointSyntax(connector.endpoint, this.env);
    if (!verdict.ok) return deny(verdict.reason);
    try { await assertResolvedAddressAllowed(verdict.url, this.env, this.deps.lookup); } catch (error) { return deny(error instanceof Error ? error.message : "endpoint address refused"); }
    const secret = this.secretOf(connector);
    if (connector.secretRef && !secret) return deny("connector secret is not configured on the server", "UNAVAILABLE");
    const client = new McpReadOnlyClient({ endpoint: connector.endpoint, timeoutMs: connector.timeoutMs, maxResponseBytes: connector.maxResponseBytes, bearer: secret, fetchImpl: this.deps.fetchImpl });
    return { connector, client, secret };
  }

  private async finish<T>(actor: McpActor, connector: ConnectorRecord, action: AuditAction, target: string, client: McpReadOnlyClient, run: () => Promise<{ value: T; detail?: string; outcome?: AuditOutcome }>): Promise<T> {
    let outcome: AuditOutcome = "OK"; let detail: string | undefined; let failure: McpPolicyError | null = null; let value: T | undefined;
    try { const r = await run(); value = r.value; detail = r.detail; outcome = r.outcome ?? "OK"; }
    catch (error) {
      if (error instanceof McpPolicyError) { failure = error; outcome = error.code === "DENIED" ? "DENIED" : error.code === "INVALID" ? "INVALID" : "ERROR"; detail = error.message; }
      else if (error instanceof McpClientError) { outcome = OUTCOME_BY_KIND[error.kind]; detail = error.message; failure = new McpPolicyError(POLICY_CODE[error.kind], error.message); }
      else { outcome = "ERROR"; detail = "unexpected connector failure"; failure = new McpPolicyError("UNAVAILABLE", "unexpected connector failure"); }
    }
    // The audit row is written BEFORE any result is released; if it cannot be written nothing is returned.
    await this.deps.store.audit({ workspaceId: actor.workspaceId, connectorId: connector.id, actorUserId: actor.userId, action, target, outcome, detail, responseBytes: client.responseBytes });
    if (failure) throw failure;
    return value as T;
  }

  private provenance(connector: ConnectorRecord, client: McpReadOnlyClient, kind: "tool" | "resource", name: string, truncated: boolean): Provenance {
    return { connectorId: connector.id, connectorName: connector.name, serverName: client.serverInfo.name ?? null, serverVersion: client.serverInfo.version ?? null, endpointOrigin: new URL(connector.endpoint).origin, kind, name, retrievedAt: new Date().toISOString(), responseBytes: client.responseBytes, truncated };
  }

  private normalizeText(parts: string[], secret?: string): { text: string; truncated: boolean } {
    const joined = redactSecrets(parts.join("\n"), secret ? [secret] : []);
    return joined.length > MAX_MODEL_TEXT_CHARS ? { text: joined.slice(0, MAX_MODEL_TEXT_CHARS), truncated: true } : { text: joined, truncated: false };
  }

  async discover(actor: McpActor, id: string): Promise<DiscoveryResult> {
    const { connector, client, secret } = await this.open(actor, id, "DISCOVER");
    return this.finish(actor, connector, "DISCOVER", connector.name, client, async () => {
      await client.initialize();
      const { tools, malformed } = await client.listTools();
      const resources = await client.listResources().catch(error => { if (error instanceof McpClientError && error.kind === "ERROR") return []; throw error; }); // servers without resources are fine
      const allowed: DiscoveryResult["tools"] = []; const denied: DiscoveryResult["deniedTools"] = [];
      for (const tool of tools) {
        const decision = decideTool(tool, connector.allowedTools);
        if (decision.allowed) allowed.push({ name: tool.name, description: tool.description ? redactSecrets(tool.description, secret ? [secret] : []).slice(0, 500) : undefined, inputSchema: tool.inputSchema });
        else denied.push({ name: tool.name, reason: decision.reason });
      }
      return { value: { serverName: client.serverInfo.name ?? null, serverVersion: client.serverInfo.version ?? null, tools: allowed, deniedTools: denied, malformedTools: malformed, resources: resources.map(r => ({ uri: redactSecrets(r.uri, secret ? [secret] : []), name: r.name ? redactSecrets(r.name, secret ? [secret] : []) : undefined, mimeType: r.mimeType })) }, detail: `tools=${allowed.length} denied=${denied.length} malformed=${malformed} resources=${resources.length}` };
    });
  }

  async readResource(actor: McpActor, id: string, uri: string): Promise<NormalizedResult> {
    const { connector, client, secret } = await this.open(actor, id, "READ_RESOURCE", uri);
    return this.finish(actor, connector, "READ_RESOURCE", uri, client, async () => {
      await client.initialize();
      const listed = await client.listResources();
      if (!listed.some(r => r.uri === uri)) throw new McpPolicyError("DENIED", "resource is not exposed by the server's resource list");
      const result = await client.readResource(uri);
      const texts: string[] = []; let ignored = 0;
      for (const content of result.contents) { if (typeof content.text === "string") texts.push(content.text); else ignored += 1; }
      if (!texts.length) throw new McpPolicyError("INVALID", "resource has no text content");
      const { text, truncated } = this.normalizeText(texts, secret);
      return { value: { kind: "resource" as const, text, isError: false, truncated, ignoredNonTextParts: ignored, provenance: this.provenance(connector, client, "resource", uri, truncated) }, detail: truncated ? "truncated" : undefined };
    });
  }

  async callTool(actor: McpActor, id: string, toolName: string, args: Record<string, unknown> = {}): Promise<NormalizedResult> {
    const { connector, client, secret } = await this.open(actor, id, "CALL_TOOL", toolName);
    return this.finish(actor, connector, "CALL_TOOL", toolName, client, async () => {
      if (Buffer.byteLength(JSON.stringify(args ?? {}), "utf8") > MAX_ARGS_BYTES) throw new McpPolicyError("INVALID", "tool arguments too large");
      await client.initialize();
      const { tools } = await client.listTools();
      const tool = tools.find(t => t.name === toolName);
      if (!tool) throw new McpPolicyError("DENIED", "tool is not exposed by the server");
      const decision = decideTool(tool, connector.allowedTools);
      if (!decision.allowed) throw new McpPolicyError("DENIED", decision.reason);
      const problems = validateArguments(tool.inputSchema, args);
      if (problems.length) throw new McpPolicyError("INVALID", `invalid arguments: ${problems.slice(0, 5).join("; ")}`);
      const result = await client.callTool(toolName, args);
      const texts: string[] = []; let ignored = 0;
      for (const part of result.content) { if ((part as { type?: string }).type === "text" && typeof (part as { text?: unknown }).text === "string") texts.push((part as { text: string }).text); else ignored += 1; }
      const { text, truncated } = this.normalizeText(texts, secret);
      return { value: { kind: "tool" as const, text, isError: result.isError === true, truncated, ignoredNonTextParts: ignored, provenance: this.provenance(connector, client, "tool", toolName, truncated) }, outcome: result.isError ? "ERROR" : "OK", detail: result.isError ? "tool reported an error" : truncated ? "truncated" : undefined };
    });
  }
}
