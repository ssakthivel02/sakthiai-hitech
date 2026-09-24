import { describe, expect, it } from "vitest";
import { mcpToolToSkillProfile, validateMcpServerContract, type McpServerContract } from "./mcp";

const remoteServer: McpServerContract = {
  id: "github-read",
  label: "GitHub Read MCP",
  transport: "streamable_http",
  endpoint: "https://mcp.example.test/api",
  tenantScoped: true,
  requiresCredential: true,
  secretRef: "secrets/github-read-mcp",
  runtimeEnabled: false,
};

describe("MCP control-plane contract", () => {
  it("accepts a tenant-scoped HTTPS server with secret references", () => {
    expect(validateMcpServerContract(remoteServer)).toEqual([]);
  });

  it("rejects insecure remote endpoints and inline credentials", () => {
    const errors = validateMcpServerContract({
      ...remoteServer,
      endpoint: "http://user:pass@example.test/mcp",
    });
    expect(errors).toContain("remote MCP endpoint must use HTTPS");
    expect(errors).toContain("MCP endpoint must not contain inline credentials");
  });

  it("maps explicitly read-only tools without approval but keeps execution disabled", () => {
    const skill = mcpToolToSkillProfile(remoteServer, {
      serverId: remoteServer.id,
      name: "search_issues",
      annotations: { readOnlyHint: true, destructiveHint: false },
    });

    expect(skill.sideEffect).toBe("none");
    expect(skill.requiresHumanApproval).toBe(false);
    expect(skill.enabled).toBe(false);
    expect(skill.tenantScoped).toBe(true);
  });

  it("fails closed for tools with missing effect annotations", () => {
    const skill = mcpToolToSkillProfile(remoteServer, {
      serverId: remoteServer.id,
      name: "unknown_action",
    });

    expect(skill.sideEffect).toBe("external_write");
    expect(skill.risk).toBe("high");
    expect(skill.requiresHumanApproval).toBe(true);
    expect(skill.enabled).toBe(false);
  });

  it("classifies destructive MCP tools as critical privileged actions", () => {
    const skill = mcpToolToSkillProfile(remoteServer, {
      serverId: remoteServer.id,
      name: "delete_resource",
      annotations: { destructiveHint: true, readOnlyHint: false },
    });

    expect(skill.sideEffect).toBe("privileged");
    expect(skill.risk).toBe("critical");
    expect(skill.requiresHumanApproval).toBe(true);
  });
});
