import { describe, expect, it } from "vitest";
import { Broker } from "./engine/broker";
import { Investigation } from "./engine/investigation";
import { buildPrompt } from "./engine/llm_contract";
import { caseFromRecord } from "./caseDoc";
import { FakeTools, newRow } from "./testkit";
import { DEFAULT_TAXONOMY } from "./taxonomy";
import type { Hypothesis } from "./engine/types";
const meta = { policy_id: "context-control", policy_kind: "llm", taxonomy: { ...DEFAULT_TAXONOMY }, strictLedger: true,
  verify: { requireSignatureSupport: false, signatureKb: "off" as const } } as const;
const fresh = () => { const c = caseFromRecord(newRow() as never); const inv = new Investigation(c, new Broker(c, new FakeTools()), meta); inv.start(); return inv; };
const view = (inv: Investigation) => { const a = inv.nextAction(); if (a.kind !== "DECIDE") throw Error("expected decision"); return a.view; };
const hyp = (status: Hypothesis["status"] = "ACTIVE", supporting: string[] = []): Hypothesis[] => [{ label: "DISK_FULL", score: 0.5, status, supporting }];
async function read(inv: Investigation, tool: string, hypotheses: Hypothesis[]) {
  view(inv); const request = { tool, target: tool === "metrics.query" ? "db-1" : "orders-db" };
  inv.applyDecision({ type: "CALL", request, rationale: "read diagnostic", hypotheses });
  const result = await inv.broker.callAsync(request); inv.recordTool(result); return result;
}
describe("engine-owned hypothesis context", () => {
  it("starts with no prior claims or evidence", () => {
    expect(view(fresh()).hypothesis_context).toEqual({ prior: [], leader: null, new_evidence: [], blocking_warnings: [] });
  });
  it("shows actual prior claims and new IDs, with replay made explicit", async () => {
    const inv = fresh(); const a = await read(inv, "logs.search", hyp());
    const snapshot = view(inv); expect(snapshot.hypothesis_context).toMatchObject({ prior: hyp(), leader: null, new_evidence: [a.records[0]!.rid] });
    const request = { tool: "metrics.query", target: "db-1" }; inv.applyDecision({ type: "CALL", request, rationale: "metrics", hypotheses: hyp("LEADING", [a.records[0]!.rid]) });
    const b = await inv.broker.callAsync(request); inv.recordTool(b);
    await read(inv, "logs.search", hyp("LEADING", [a.records[0]!.rid]));
    const current = view(inv); expect(current.hypothesis_context).toMatchObject({ leader: "DISK_FULL", new_evidence: [] });
    const serialized = JSON.parse(buildPrompt(current).user);
    expect(serialized.history.at(-1).replayed).toBe(true);
    expect(serialized.hypothesis_context.new_evidence).toEqual([]);
  });
  it("does not let snapshot mutation rewrite claims or fresh-evidence state", async () => {
    const inv = fresh(); const a = await read(inv, "logs.search", hyp());
    const snapshot = view(inv).hypothesis_context!; snapshot.prior[0]!.score = 1; snapshot.new_evidence.length = 0;
    const again = view(inv).hypothesis_context!;
    expect(again.prior[0]!.score).toBe(0.5); expect(again.new_evidence).toEqual([a.records[0]!.rid]);
  });
  it("reconstructs the same context after checkpoint resume", async () => {
    const inv = fresh(); await read(inv, "logs.search", hyp()); const cp = inv.snapshot();
    const resumed = Investigation.resume(inv.c, new Broker(inv.c, new FakeTools()), cp, meta);
    const expected = view(inv).hypothesis_context; expect(expected).toBeDefined();
    expect(view(resumed).hypothesis_context).toEqual(expected);
  });
  it("exposes existing blocking warnings without letting the snapshot erase them", async () => {
    const inv = fresh(); await read(inv, "logs.search", hyp("LEADING"));
    await read(inv, "metrics.query", [{ label: "DNS_MISCONFIG", score: 0.8, status: "LEADING", supporting: [] }]);
    const ctx = view(inv).hypothesis_context!; expect(ctx.blocking_warnings).toContain("LEADER_CHANGE_WITHOUT_NEW_EVIDENCE:DISK_FULL->DNS_MISCONFIG");
    ctx.blocking_warnings.length = 0; expect(inv.ledgerWarnings).toContain("LEADER_CHANGE_WITHOUT_NEW_EVIDENCE:DISK_FULL->DNS_MISCONFIG");
  });
  it("reports warnings as blocking only when strict enforcement is active", async () => {
    const c = caseFromRecord(newRow() as never); const inv = new Investigation(c, new Broker(c, new FakeTools()), { ...meta, strictLedger: false }); inv.start();
    await read(inv, "logs.search", hyp("LEADING"));
    await read(inv, "metrics.query", [{ label: "DNS_MISCONFIG", score: 0.8, status: "LEADING", supporting: [] }]);
    expect(inv.ledgerWarnings.length).toBeGreaterThan(0); expect(view(inv).hypothesis_context!.blocking_warnings).toEqual([]);
  });
  it("still rejects a final leader promotion after cached evidence", async () => {
    const inv = fresh(); const a = await read(inv, "logs.search", hyp()); const b = await read(inv, "metrics.query", hyp());
    await read(inv, "logs.search", hyp()); view(inv); const cited = [a.records[0]!.rid, b.records[0]!.rid];
    inv.applyDecision({ type: "FINAL", hypotheses: hyp("SUPPORTED", cited), final: { outcome: "DIAGNOSIS", label: "DISK_FULL", summary: "Disk signals", cited, contradictions: [], confidence: 0.8,
      remediation: { text: "Review capacity", executed: false, requires_approval: true }, next_safe_steps: [] } });
    const result = inv.finish(); expect(result.stop_reason).toBe("LEDGER_REJECTED"); expect(result.final.outcome).toBe("ABSTAIN");
  });
});

/** Four real broker records: the ledger supports the first record from each tool. */
async function citationScenario(strictLedger = true) {
  const c = caseFromRecord(newRow() as never);
  const tools = new FakeTools((tool) => tool === "metrics.query"
    ? ["WARN data volume usage 100 percent", "INFO CPU utilisation 10 percent"]
    : ["ERROR no space left on device while writing", "INFO routine health probe received"]);
  const inv = new Investigation(c, new Broker(c, tools), { ...meta, strictLedger }); inv.start();
  const logs = await read(inv, "logs.search", hyp("LEADING"));
  const metrics = await read(inv, "metrics.query", hyp("LEADING", [logs.records[0]!.rid]));
  return { inv, support: [logs.records[0]!.rid, metrics.records[0]!.rid], other: [logs.records[1]!.rid, metrics.records[1]!.rid] };
}
function conclude(inv: Investigation, supporting: string[], cited: string[]) {
  view(inv);
  inv.applyDecision({ type: "FINAL", hypotheses: hyp("SUPPORTED", supporting), final: {
    outcome: "DIAGNOSIS", label: "DISK_FULL", summary: "Disk pressure is suggested by collected telemetry.", cited,
    contradictions: [], confidence: 0.8, remediation: { text: "Review storage capacity under change control", executed: false, requires_approval: true }, next_safe_steps: [],
  } });
  return inv.finish();
}

describe("final citations remain connected to the reported leading hypothesis", () => {
  it("strict mode abstains when all final citations differ from the leader's support", async () => {
    const { inv, support, other } = await citationScenario();
    const r = conclude(inv, support, other);
    expect(r.ledger_warnings).toContain("FINAL_CITATIONS_DISJOINT_FROM_LEDGER:DISK_FULL");
    expect(r.stop_reason).toBe("LEDGER_REJECTED"); expect(r.final.outcome).toBe("ABSTAIN"); expect(r.trace_ok).toBe(true);
    expect(r.final.remediation).toMatchObject({ executed: false, requires_approval: true });
  });
  it("retains that restriction across a durable investigation checkpoint", async () => {
    const { inv, support, other } = await citationScenario(); const cp = inv.snapshot();
    const resumed = Investigation.resume(inv.c, new Broker(inv.c, new FakeTools()), cp, meta);
    const r = conclude(resumed, support, other);
    expect(r.stop_reason).toBe("LEDGER_REJECTED"); expect(r.final.outcome).toBe("ABSTAIN"); expect(r.trace_ok).toBe(true);
  });
  it("accepts structurally valid citations that include the leader's supporting records", async () => {
    const { inv, support } = await citationScenario(); const r = conclude(inv, support, support);
    expect(r.stop_reason).toBe("POLICY_FINAL"); expect(r.final.outcome).toBe("DIAGNOSIS"); expect(r.verified).toBe(true); expect(r.trace_ok).toBe(true);
  });
  it("permits additional citations when at least one leader-support record is retained", async () => {
    const { inv, support, other } = await citationScenario(); const r = conclude(inv, support, [support[0]!, other[1]!]);
    expect(r.final.outcome).toBe("DIAGNOSIS"); expect(r.verified).toBe(true); expect(r.trace_ok).toBe(true);
  });
  it("preserves warning-only behaviour when strict ledger enforcement is explicitly off", async () => {
    const { inv, support, other } = await citationScenario(false); const r = conclude(inv, support, other);
    expect(r.ledger_warnings).toContain("FINAL_CITATIONS_DISJOINT_FROM_LEDGER:DISK_FULL");
    expect(r.stop_reason).toBe("POLICY_FINAL"); expect(r.final.outcome).toBe("DIAGNOSIS"); expect(r.verified).toBe(true);
  });
});

describe("contradictory duplicate hypotheses cannot enter the investigation ledger", () => {
  it("fails closed at the contract boundary before storing a supported/rejected duplicate label", async () => {
    const { GatewayPolicy } = await import("./engine/gateway_policy");
    const { MockModelTransport } = await import("./engine/model_transport");
    const { investigateAsync } = await import("./engine/orchestrator");
    const tools = new FakeTools();
    const model = new MockModelTransport(req => {
      const history = JSON.parse(req.user).history as Array<{ records: Array<{ rid: string }> }>;
      const ids = history.flatMap(h => h.records.map(r => r.rid));
      if (!ids.length) return JSON.stringify({ type: "CALL", tool: "logs.search", target: "orders-db", rationale: "Read errors", hypotheses: hyp("LEADING") });
      if (ids.length === 1) return JSON.stringify({ type: "CALL", tool: "metrics.query", target: "db-1", rationale: "Read capacity", hypotheses: hyp("LEADING", ids) });
      return JSON.stringify({ type: "FINAL", outcome: "DIAGNOSIS", label: "DISK_FULL", summary: "Disk capacity signals are present", cited: ids, confidence: 0.8, remediation_proposal: "Review capacity under change control", hypotheses: [...hyp("SUPPORTED", ids), ...hyp("REJECTED")] });
    });
    const policy = new GatewayPolicy(model, { maxModelCalls: 3, formatRetries: 0 });
    const r = await investigateAsync(caseFromRecord(newRow() as never), { policy, transport: tools, taxonomy: { ...DEFAULT_TAXONOMY }, strictLedger: true, verify: { requireSignatureSupport: false, signatureKb: "off" } });
    expect(r.stop_reason).toBe("POLICY_ERROR"); expect(r.final.outcome).toBe("ABSTAIN"); expect(r.trace_ok).toBe(true);
    expect(model.calls).toHaveLength(3); expect(tools.calls).toHaveLength(2);
    expect(r.hypothesis_history.every(h => new Set(h.hypotheses.map(x => x.label)).size === h.hypotheses.length)).toBe(true);
  });
});
