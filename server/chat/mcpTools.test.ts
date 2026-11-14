import { describe, expect, it } from "vitest";
import { mcpReadPolicyAllows, mcpToolsEnabled, parseToolChoice, runSelectedTool, toolSelectionMessages } from "./mcpTools";
import { McpPolicyError } from "../connectors/mcp";

const ID = "6f1c2a3e-4b5d-4e6f-8a9b-0c1d2e3f4a5b";
describe("MCP chat tools: policy gate and model-choice parsing", () => {
  it("is off by default; only the exact string 'true' enables it", () => {
    expect(mcpToolsEnabled({})).toBe(false); expect(mcpReadPolicyAllows({})).toBe(false);
    for (const v of ["1", "TRUE", "yes", ""]) expect(mcpReadPolicyAllows({ MCP_CHAT_TOOLS_ENABLED: v })).toBe(false);
    expect(mcpReadPolicyAllows({ MCP_CHAT_TOOLS_ENABLED: "true" })).toBe(true);
  });
  it("accepts only a strict {connectorId, tool, arguments} choice; endpoint/url/command keys invalidate it", () => {
    expect(parseToolChoice('{"tool":null}')).toEqual({ kind: "none" });
    expect(parseToolChoice("I will not call a tool")).toEqual({ kind: "none" });
    expect(parseToolChoice(`Sure: {"connectorId":"${ID}","tool":"search_docs","arguments":{"query":"x"}}`)).toMatchObject({ kind: "choice", choice: { connectorId: ID, tool: "search_docs", arguments: { query: "x" } } });
    for (const extra of ["endpoint", "url", "command", "baseUrl", "headers"]) expect(parseToolChoice(`{"connectorId":"${ID}","tool":"t","arguments":{},"${extra}":"https://evil.example"}`).kind).toBe("invalid");
    expect(parseToolChoice('{"connectorId":"not-a-uuid","tool":"t"}').kind).toBe("invalid");
    expect(parseToolChoice('{"connectorId":').kind).toBe("none"); // truncated output: nothing is called
    expect(parseToolChoice('{"connectorId": nope}').kind).toBe("invalid");
  });
  it("a tool that was not offered is refused without touching the service", async () => {
    const service: any = { callTool: async () => { throw new Error("must not be called"); } };
    const offered = [{ connectorId: ID, connectorName: "c", tool: "search_docs", inputSchema: {} }];
    expect(await runSelectedTool(service, { workspaceId: 1 }, offered, { connectorId: ID, tool: "delete_record", arguments: {} })).toEqual({ status: "refused", reason: "tool was not offered" });
    expect(await runSelectedTool(service, { workspaceId: 1 }, offered, { connectorId: "00000000-0000-4000-8000-000000000000", tool: "search_docs", arguments: {} })).toMatchObject({ status: "refused" });
  });
  it("service refusals become a refusal result; unexpected errors propagate", async () => {
    const offered = [{ connectorId: ID, connectorName: "c", tool: "t", inputSchema: {} }];
    const denied: any = { callTool: async () => { throw new McpPolicyError("DENIED", "nope"); } };
    expect(await runSelectedTool(denied, { workspaceId: 1 }, offered, { connectorId: ID, tool: "t", arguments: {} })).toEqual({ status: "refused", reason: "DENIED" });
    const boom: any = { callTool: async () => { throw new Error("db"); } };
    await expect(runSelectedTool(boom, { workspaceId: 1 }, offered, { connectorId: ID, tool: "t", arguments: {} })).rejects.toThrow("db");
  });
  it("the selection prompt labels tool descriptions as untrusted and never contains an endpoint", () => {
    const m = toolSelectionMessages([{ connectorId: ID, connectorName: "c", tool: "t", description: "d", inputSchema: {} }], "q");
    expect(m[0].content).toMatch(/untrusted/); expect(m[0].content).not.toMatch(/https?:\/\//);
  });
});
