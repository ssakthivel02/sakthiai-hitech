import { describe, expect, it } from "vitest";
import { buildPrompt } from "./engine/llm_contract";
import { caseFromRecord } from "./caseDoc";
import { newRow } from "./testkit";
import { DEFAULT_TAXONOMY } from "./taxonomy";
import type { PolicyView, ToolResult } from "./engine/types";
const result = (tool: string, rid: string, obs: string, quarantined = false): ToolResult => ({
  seq: 0, request: { tool, target: "db-1" }, status: "OK", records: [{ rid, obs_id: obs, ts: "2026-10-01T10:00:00Z", level: "INFO", text: "diagnostic data", quarantined }],
  quarantined: [], attempts: 1, replayed: false, virtual_ms: 1, result_hash: "fixture",
});
const prompt = (history: ToolResult[], overrides: Partial<PolicyView> = {}) => {
  const view: PolicyView = { case: caseFromRecord(newRow() as never), history, calls_left: 3, steps_left: 6, virtual_ms_left: 1000, force_final: false, taxonomy: { ...DEFAULT_TAXONOMY }, ...overrides };
  return JSON.parse(buildPrompt(view).user).evidence_inventory;
};
describe("model-visible corroboration inventory", () => {
  it("makes the missing second tool explicit after a single diagnostic", () => {
    expect(prompt([result("logs.search", "r1", "o1")])).toEqual({ clean_records: 1, distinct_observations: 1, tools_with_records: ["logs.search"], minimum_for_diagnosis: { records: 2, observations: 2, tools: 2 }, structural_minimum_met: false });
  });
  it("does not count multiple lines from one observation as corroboration", () => {
    const a = result("logs.search", "r1", "o1"); a.records.push({ ...a.records[0]!, rid: "r2" });
    expect(prompt([a])).toMatchObject({ clean_records: 2, distinct_observations: 1, structural_minimum_met: false });
  });
  it("does not count a cached result twice", () => {
    const a = result("logs.search", "r1", "o1");
    expect(prompt([a, { ...a, replayed: true }])).toMatchObject({ clean_records: 1, distinct_observations: 1, structural_minimum_met: false });
  });
  it("excludes quarantined evidence and failed or denied results", () => {
    const clean = result("logs.search", "r1", "o1");
    for (const status of ["DENIED", "ERROR", "TIMEOUT", "NO_DATA"] as const) {
      expect(prompt([clean, { ...result("config.get", "r2", "o2"), status }]).structural_minimum_met).toBe(false);
    }
    expect(prompt([clean, result("config.get", "r2", "o2", true)])).toMatchObject({ clean_records: 1, tools_with_records: ["logs.search"], structural_minimum_met: false });
  });
  it("does not assert independence when tool names share an observation", () => {
    expect(prompt([result("logs.search", "r1", "same"), result("config.get", "r2", "same")])).toMatchObject({ distinct_observations: 1, structural_minimum_met: false });
  });
  it("reports structural counts without declaring diagnostic correctness or mutating history", () => {
    const history = [result("logs.search", "r1", "o1"), result("config.get", "r2", "o2")];
    const before = structuredClone(history);
    expect(prompt(history)).toMatchObject({ clean_records: 2, distinct_observations: 2, tools_with_records: ["logs.search", "config.get"], structural_minimum_met: true });
    expect(history).toEqual(before);
  });
  it("keeps force-final authoritative when corroboration is missing", () => {
    const v: PolicyView = { case: caseFromRecord(newRow() as never), history: [], calls_left: 0, steps_left: 0, virtual_ms_left: 0, force_final: true, taxonomy: { ...DEFAULT_TAXONOMY } };
    const p = buildPrompt(v); expect(JSON.parse(p.user).budget.force_final).toBe(true);
    expect(p.system).toContain("When budget.force_final is true, return FINAL, never CALL");
    expect(p.system).toContain("structural_minimum_met is not a diagnosis approval");
  });
  it("keeps both final outcomes structurally possible at a final-only boundary with corroboration", () => {
    const history = [result("logs.search", "r1", "o1"), result("config.get", "r2", "o2")];
    const v: PolicyView = { case: caseFromRecord(newRow() as never), history, calls_left: 0, steps_left: 0, virtual_ms_left: 0, force_final: true, taxonomy: { ...DEFAULT_TAXONOMY } };
    const state = JSON.parse(buildPrompt(v).user);
    expect(state.budget.structural_final_outcomes).toEqual(["DIAGNOSIS", "ABSTAIN"]);
    expect(state.budget.force_final).toBe(true);
    expect(state.tool_policy.uncached_default_requests).toEqual([]);
  });
  it("offers only abstention as a final outcome when structural corroboration is missing", () => {
    for (const history of [[], [result("logs.search", "r1", "o1")], [result("logs.search", "r1", "o1"), result("config.get", "r2", "o2", true)]]) {
      const v: PolicyView = { case: caseFromRecord(newRow() as never), history, calls_left: 0, steps_left: 0, virtual_ms_left: 0, force_final: true, taxonomy: { ...DEFAULT_TAXONOMY } };
      const state = JSON.parse(buildPrompt(v).user);
      expect(state.budget.structural_final_outcomes).toEqual(["ABSTAIN"]);
      expect(state.tool_policy.uncached_default_requests).toEqual([]);
    }
  });

});
