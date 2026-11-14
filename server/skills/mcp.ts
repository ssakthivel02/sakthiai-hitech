import type { SideEffectLevel, SkillProfile, SkillRisk } from "./types";

export type McpTransport = "stdio" | "streamable_http";

export interface McpServerContract {
  id: string;
  label: string;
  transport: McpTransport;
  endpoint?: string;
  tenantScoped: boolean;
  requiresCredential: boolean;
  secretRef?: string;
  runtimeEnabled: boolean;
}

export interface McpToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
}

export interface McpToolDescriptor {
  serverId: string;
  name: string;
  description?: string;
  annotations?: McpToolAnnotations;
}

export function validateMcpServerContract(server: McpServerContract): string[] {
  const errors: string[] = [];
  if (!server.id.trim()) errors.push("server id is required");
  if (!server.tenantScoped) errors.push("MCP server must be tenant scoped");
  if (server.requiresCredential && !server.secretRef) errors.push("credentialed MCP server requires a secret reference");
  if (server.secretRef && /:\/\//.test(server.secretRef)) errors.push("secretRef must be a reference, not a URL or inline secret");

  if (server.transport === "streamable_http") {
    if (!server.endpoint) errors.push("streamable_http MCP server requires an endpoint");
    else {
      try {
        const url = new URL(server.endpoint);
        if (url.protocol !== "https:") errors.push("remote MCP endpoint must use HTTPS");
        if (url.username || url.password) errors.push("MCP endpoint must not contain inline credentials");
      } catch {
        errors.push("MCP endpoint must be a valid URL");
      }
    }
  }

  return errors;
}

function classification(tool: McpToolDescriptor): {
  sideEffect: SideEffectLevel;
  risk: SkillRisk;
  requiresHumanApproval: boolean;
} {
  const annotations = tool.annotations;

  if (annotations?.destructiveHint === true) {
    return { sideEffect: "privileged", risk: "critical", requiresHumanApproval: true };
  }

  if (annotations?.readOnlyHint === true) {
    return { sideEffect: "none", risk: "medium", requiresHumanApproval: false };
  }

  // Missing/ambiguous annotations fail closed. An MCP server may expose tools
  // with externally visible effects, so unknown tools must never be treated as read-only.
  return { sideEffect: "external_write", risk: "high", requiresHumanApproval: true };
}

/**
 * Convert MCP tool metadata into SakthiAI's governed skill vocabulary.
 * Tool execution remains disabled until a separately reviewed runtime binding exists.
 */
export function mcpToolToSkillProfile(server: McpServerContract, tool: McpToolDescriptor): SkillProfile {
  if (tool.serverId !== server.id) throw new Error("MCP tool/server mismatch");
  const safety = classification(tool);

  return {
    id: `mcp.${server.id}.${tool.name}`,
    label: tool.name,
    kind: "connector",
    description: tool.description ?? `MCP tool ${tool.name}`,
    sideEffect: safety.sideEffect,
    risk: safety.risk,
    enabled: false,
    requiresNetwork: server.transport === "streamable_http",
    requiresCredential: server.requiresCredential,
    requiresHumanApproval: safety.requiresHumanApproval,
    meteredSpendPossible: false,
    tenantScoped: true,
  };
}
