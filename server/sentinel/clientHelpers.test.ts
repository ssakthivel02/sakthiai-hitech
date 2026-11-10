import { describe, expect, it } from "vitest";
import { confidencePct, draftToBinding, emptyDraft, formatDuration, humanLabel, relativeTime, splitList, statusMeta, suggestMcpTool, validateDrafts } from "../../client/src/components/sentinel/format";

describe("sentinel UI helpers", () => {
  it("formats labels, durations, confidence and times defensively", () => {
    expect(humanLabel("DISK_FULL")).toBe("Disk full");
    expect(formatDuration(450)).toBe("450 ms"); expect(formatDuration(2500)).toBe("2.5 s"); expect(formatDuration(125_000)).toBe("2 min 5 s"); expect(formatDuration(-1)).toBe("–"); expect(formatDuration(NaN)).toBe("–");
    expect(confidencePct(0.856)).toBe("86%"); expect(confidencePct(7)).toBe("100%"); expect(confidencePct(null)).toBe("–");
    const now = Date.parse("2026-10-17T12:00:00Z");
    expect(relativeTime("2026-10-17T11:59:50Z", now)).toBe("just now"); expect(relativeTime("2026-10-17T11:30:00Z", now)).toBe("30 min ago"); expect(relativeTime("2026-10-17T11:00:00Z", now)).toBe("1 h ago"); expect(relativeTime("not-a-date", now)).toBe("not-a-date"); expect(relativeTime(null, now)).toBe("–");
  });
  it("knows which statuses are terminal and falls back for unknown ones", () => {
    expect(statusMeta("COMPLETED").terminal).toBe(true); expect(statusMeta("RUNNING").terminal).toBe(false); expect(statusMeta("WEIRD")).toMatchObject({ label: "WEIRD", terminal: false });
  });
  it("splits lists on commas/newlines and de-duplicates", () => { expect(splitList("a, b\nb ,, c")).toEqual(["a", "b", "c"]); });

  it("suggests only read-looking connector tools", () => {
    expect(suggestMcpTool("logs.search", ["restart_service", "search_logs"])).toBe("search_logs");
    expect(suggestMcpTool("config.get", ["update_config", "get_config"])).toBe("get_config");
    expect(suggestMcpTool("logs.search", ["delete_logs"])).toBe("");          // matches the hint but looks mutating
    expect(suggestMcpTool("unknown.tool", ["search_logs"])).toBe("");
  });
  it("validates binding drafts before they reach the API", () => {
    expect(validateDrafts([])).toHaveLength(1);
    const ok = { ...emptyDraft("logs.search"), connectorId: "c", mcpTool: "search_logs" };
    expect(validateDrafts([ok])).toEqual([]);
    expect(validateDrafts([ok, ok]).join(" ")).toMatch(/already bound/);
    expect(validateDrafts([{ ...ok, mcpTool: "restart_service" }]).join(" ")).toMatch(/mutating/);
    expect(validateDrafts([{ ...ok, connectorId: "" }]).join(" ")).toMatch(/connector/);
    expect(validateDrafts([{ ...ok, targetParam: "bad name!" }]).join(" ")).toMatch(/target argument/);
    expect(draftToBinding({ ...ok, queryParam: " q ", windowParam: "" })).toEqual({ tool: "logs.search", connectorId: "c", mcpTool: "search_logs", targetParam: "service", queryParam: "q" });
  });
});

import { budgetLine, providerLine, recentLine } from "../../client/src/components/sentinel/runtimeFormat";
describe("runtime panel helpers are truthful", () => {
  it("only a real answered call earns the ok tone; configured is not working", () => {
    const base = { providerId: "x", kind: "external", runtimeClass: "hosted" as const, billingMode: "metered_api", breaker: "CLOSED", eligibleForWorkspace: true };
    expect(providerLine({ ...base, state: "configured_unverified" }).tone).toBe("warn");
    expect(providerLine({ ...base, state: "reachable_compatible", modelId: "m", endpointProfile: "sarvam-chat" })).toMatchObject({ tone: "ok", title: "External model" });
    expect(providerLine({ ...base, state: "reachable_compatible", eligibleForWorkspace: false }).detail).toMatch(/no calls are sent/);
    const bad = providerLine({ ...base, state: "invalid_configuration", invalidReason: "host is not allowed" });
    expect(bad.tone).toBe("bad"); expect(bad.detail).toContain("Refused: host is not allowed");
    expect(providerLine({ ...base, runtimeClass: "local", kind: "self_hosted", billingMode: "local_compute", state: "disabled" }).detail).toContain("no per-call charge");
  });
  it("budget lines never invent a limit or a remainder", () => {
    expect(budgetLine("Requests", 3, undefined, undefined)).toBe("Requests: no limit set");
    expect(budgetLine("Estimated cost", 1.2345, 10, 8.7655, "INR")).toBe("Estimated cost: 1.23 INR used of 10 INR (8.77 INR left)");
    expect(budgetLine("Tokens", null, 1000, null)).toBe("Tokens: usage unknown of 1000");
    expect(recentLine({ status: "failed", reason: "budget_denied", fellBack: false, latencyMs: 1 })).toBe("Refused or failed: budget denied");
    expect(recentLine({ status: "returned", modelId: "m", fellBack: true, latencyMs: 40 })).toContain("after another provider was tried or skipped");
  });
});
