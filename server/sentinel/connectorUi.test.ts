import { describe, expect, it } from "vitest";
import { LOCALITY_SHORT, modelStatus, toolCoverage, validateRegistration } from "../../client/src/components/sentinel/format";
import { classifyEndpoint, connectorCatalog } from "./adapters/connectorInfo";
import { reportStem } from "./report";

describe("endpoint locality (never claims production)", () => {
  it("classifies loopback, private and remote endpoints", () => {
    expect(classifyEndpoint("http://127.0.0.1:9/mcp")).toBe("local");
    expect(classifyEndpoint("http://localhost/mcp")).toBe("local");
    expect(classifyEndpoint("http://[::1]:9/mcp")).toBe("local");
    expect(classifyEndpoint("https://10.1.2.3/mcp")).toBe("private-network");
    expect(classifyEndpoint("https://192.168.1.5/mcp")).toBe("private-network");
    expect(classifyEndpoint("https://mcp.example.com/mcp")).toBe("remote");
    expect(classifyEndpoint("not a url")).toBe("remote");
    expect(Object.values(LOCALITY_SHORT).join(" ")).not.toMatch(/production|verified production/i);
  });
  it("catalogue exposes secret reference names only, never values", () => {
    const c = connectorCatalog({ MCP_ALLOWED_ENDPOINTS: "https://mcp.example.com", MCP_SECRET_PROD_TOKEN: "s3cr3t-value", MCP_SECRET_bad: "x", MCP_ALLOW_LOOPBACK_HTTP: "true" });
    expect(c.secretRefs).toEqual(["PROD_TOKEN"]);
    expect(JSON.stringify(c)).not.toContain("s3cr3t-value");
    expect(c.approvedOrigins).toEqual([{ origin: "https://mcp.example.com", locality: "remote" }]);
    expect(c.loopbackHttpAllowed).toBe(true);
  });
});

describe("model status honesty", () => {
  it("configured is not verified; blocking states block start", () => {
    expect(modelStatus({ state: "eligible", configuredProviders: 1, eligibleProviders: 1, operational: "unverified" }).label).toBe("Configured, not yet verified");
    expect(modelStatus({ state: "eligible", configuredProviders: 1, eligibleProviders: 1, operational: "verified" }).tone).toBe("ok");
    expect(modelStatus({ state: "no_provider_configured", configuredProviders: 0, eligibleProviders: 0, operational: "unverified" }).blocksStart).toBe(true);
    expect(modelStatus({ state: "not_permitted_by_policy", configuredProviders: 1, eligibleProviders: 0, operational: "unverified" }).blocksStart).toBe(true);
    expect(modelStatus(null).blocksStart).toBe(false);
  });
});

describe("tool coverage and registration validation", () => {
  it("suggests only discovered tools", () => {
    const cov = toolCoverage(["logs.search", "deploys.list"], [{ connectorId: "c", connectorName: "syn", tools: ["search_logs"] }]);
    expect(cov[0]).toEqual({ tool: "logs.search", connectorName: "syn", mcpTool: "search_logs" });
    expect(cov[1]).toEqual({ tool: "deploys.list", connectorName: null, mcpTool: null });
  });
  const ok = { name: "diag", endpoint: "https://mcp.example.com/mcp", secretRef: "TOK", timeoutMs: "8000", maxResponseBytes: "262144" };
  it("accepts a valid registration and rejects unsafe ones", () => {
    const approved = ["https://mcp.example.com"];
    expect(validateRegistration(ok, approved)).toEqual([]);
    expect(validateRegistration({ ...ok, endpoint: "https://evil.test/mcp" }, approved).join()).toMatch(/not an operator-approved/);
    expect(validateRegistration({ ...ok, endpoint: "https://u:p@mcp.example.com/mcp" }, approved).join()).toMatch(/credentials/);
    expect(validateRegistration({ ...ok, endpoint: "https://mcp.example.com/mcp?k=1" }, approved).join()).toMatch(/query string/);
    expect(validateRegistration({ ...ok, secretRef: "my-actual-secret" }, approved).join()).toMatch(/never a secret value/);
    expect(validateRegistration({ ...ok, timeoutMs: "5" }, approved).join()).toMatch(/Timeout/);
  });
});

describe("report filenames", () => {
  it("are safe and stable", () => {
    expect(reportStem("Write failures on orders-db", "507ae2e1-d2a7-4243")).toBe("sentinel-write-failures-on-orders-db-507ae2e1");
    expect(reportStem("../../etc/passwd ‮<script>", "ab/../cd")).toMatch(/^sentinel-[a-z0-9-]+-abcd$/);
    expect(reportStem("日本語", "abcdef12-0")).toBe("sentinel-abcdef12");
  });
});
