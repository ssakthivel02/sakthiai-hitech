import { describe, expect, it } from "vitest";
import { Broker } from "./engine/broker";
import { Investigation } from "./engine/investigation";
import { CheckpointError, type Checkpoint } from "./engine/checkpoint";
import { caseFromRecord } from "./caseDoc";
import { FakeTools, newRow } from "./testkit";
import { DEFAULT_TAXONOMY } from "./taxonomy";
import { checkpointFromEvents } from "./replay";
import type { Hypothesis } from "./engine/types";
const meta = { policy_id: "checkpoint-ledger-control", policy_kind: "llm", taxonomy: { ...DEFAULT_TAXONOMY }, strictLedger: true,
  verify: { requireSignatureSupport: false, signatureKb: "off" as const } };
const prior: Hypothesis = { label: "DISK_FULL", score: 0.4, status: "LEADING", supporting: [] };
async function snapshot(hypotheses: Hypothesis[] = [prior], invMeta = meta, pending = false) {
  const c = caseFromRecord(newRow() as never), inv = new Investigation(c, new Broker(c, new FakeTools()), invMeta);
  inv.start(); expect(inv.nextAction().kind).toBe("DECIDE");
  const request = { tool: "logs.search", target: "orders-db" };
  inv.applyDecision({ type: "CALL", request, rationale: "Read diagnostic evidence", hypotheses: structuredClone(hypotheses) });
  if (!pending) inv.recordTool(await inv.broker.callAsync(request));
  return { c, inv, cp: JSON.parse(JSON.stringify(inv.snapshot())) as Checkpoint };
}
describe("checkpoint hypothesis history remains bound to verified decisions", () => {
  it.each(["label", "score", "support", "removed-history", "step"] as const)("rejects a changed %s before restoring broker state", async field => {
    const { c, cp } = await snapshot();
    if (field === "removed-history") cp.hypothesis_history = [];
    else if (field === "step") cp.hypothesis_history[0]!.step++;
    else {
      const h = cp.hypothesis_history[0]!.hypotheses[0]!;
      if (field === "label") h.label = "DNS_MISCONFIG";
      if (field === "score") h.score = 1;
      if (field === "support") h.supporting = [cp.results[0]!.records[0]!.rid];
    }
    const before = structuredClone(cp), tools = new FakeTools(), broker = new Broker(c, tools);
    expect(() => Investigation.resume(c, broker, cp, meta)).toThrowError(expect.objectContaining({ code: "HYPOTHESIS_HISTORY_MISMATCH" }));
    expect(broker.evidence.size).toBe(0); expect(broker.stats.calls_used).toBe(0); expect(tools.calls).toHaveLength(0); expect(cp).toEqual(before);
  });
  it("rejects an internally consistent legacy trace containing duplicate label identities", async () => {
    // Bypass today's JSON parser to reproduce a checkpoint older parsers could create.
    const { c, cp } = await snapshot([prior, { ...prior, status: "REJECTED" }]);
    const before = structuredClone(cp), tools = new FakeTools(), broker = new Broker(c, tools);
    expect(() => Investigation.resume(c, broker, cp, meta)).toThrowError(expect.objectContaining({ code: "DUPLICATE_HYPOTHESIS_LABEL" }));
    expect(broker.evidence.size).toBe(0); expect(tools.calls).toHaveLength(0); expect(cp).toEqual(before);
  });
  it("preserves the normal handler's trace-derived history and JSON round-trip resume", async () => {
    const { c, cp } = await snapshot(); const recorded = structuredClone(cp.trace);
    cp.hypothesis_history[0]!.hypotheses[0]!.label = "DNS_MISCONFIG";
    const rebuilt = checkpointFromEvents(c.case_id, recorded)!;
    expect(rebuilt.hypothesis_history[0]!.hypotheses[0]!.label).toBe("DISK_FULL");
    const resumed = Investigation.resume(c, new Broker(c, new FakeTools()), JSON.parse(JSON.stringify(rebuilt)), meta);
    const next = resumed.nextAction(); if (next.kind !== "DECIDE") throw new CheckpointError("EXPECTED_DECISION");
    expect(next.view.hypothesis_context!.leader).toBe("DISK_FULL"); expect(resumed.snapshot().resumes).toBe(1);
  });
});


describe("durable handler rejection of ambiguous legacy ledgers", () => {
  it("is non-retryable and leaves stored events and model reservations untouched", async () => {
    const { createSentinelInvestigateHandler } = await import("./handler");
    const { InMemorySentinelStore } = await import("./testing");
    const { fakeCtx, goodModel, ID, WS } = await import("./testkit");
    const { TaskFatalError } = await import("../tasks/types");
    const model = goodModel(), tools = new FakeTools(), store = new InMemorySentinelStore();
    const { cp } = await snapshot([prior, { ...prior, status: "REJECTED" }], { ...meta, policy_id: `gateway:${model.id}` });
    const { ctx, state } = fakeCtx({ checkpoint: { investigationId: ID, seq: cp.trace.length, traceHead: cp.trace_head, modelCalls: 1 } });
    await store.create(newRow()); await store.attachTask(WS, ID, ctx.task.id); await store.appendEvents(WS, ID, cp.trace);
    const handler = createSentinelInvestigateHandler({ store, enabled: () => true,
      config: () => ({ policyTimeoutMs: 1000, toolAttemptTimeoutMs: 1000, maxModelCalls: 4, formatRetries: 1, cancelPollMs: 10 }),
      transportFor: () => tools, modelFor: () => model });
    let error: unknown; try { await handler(ctx); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(TaskFatalError); expect((error as Error).message).toContain("DUPLICATE_HYPOTHESIS_LABEL");
    expect(model.calls).toHaveLength(0); expect(tools.calls).toHaveLength(0); expect(state.checkpoints).toBe(0);
    expect(ctx.checkpoint).toEqual({ investigationId: ID, seq: cp.trace.length, traceHead: cp.trace_head, modelCalls: 1 });
    expect(await store.readEvents(WS, ID)).toEqual(cp.trace);
  });
});


describe("checkpoint counters do not contradict recorded progress", () => {
  it("does not refund an already-recorded decision step", async () => {
    const { c, cp } = await snapshot(); cp.step = 0;
    const tools = new FakeTools(), broker = new Broker(c, tools);
    expect(() => Investigation.resume(c, broker, cp, meta)).toThrowError(expect.objectContaining({ code: "STEP_BEHIND_TRACE" }));
    expect(broker.evidence.size).toBe(0); expect(tools.calls).toHaveLength(0);
  });
  it("binds a pending tool step to its recorded request", async () => {
    const { c, cp } = await snapshot([prior], meta, true); cp.step = 2; cp.pending!.step = 2;
    expect(() => Investigation.resume(c, new Broker(c, new FakeTools()), cp, meta)).toThrowError(expect.objectContaining({ code: "PENDING_MISMATCH" }));
  });
  it.each([-1, "0", 3])("rejects a resume count %j inconsistent with the recorded resume events", async count => {
    const { c, cp } = await snapshot(); cp.resumes = count as number;
    expect(() => Investigation.resume(c, new Broker(c, new FakeTools()), cp, meta)).toThrowError(expect.objectContaining({ code: "RESUME_COUNT" }));
  });
  it("preserves a legitimate conservative cursor captured during an unrecorded policy decision", async () => {
    const { c, inv } = await snapshot(); expect(inv.nextAction().kind).toBe("DECIDE");
    const cp = JSON.parse(JSON.stringify(inv.snapshot())) as Checkpoint;
    expect(cp.step).toBe(2); expect(cp.hypothesis_history.at(-1)!.step).toBe(1);
    const resumed = Investigation.resume(c, new Broker(c, new FakeTools()), cp, meta);
    expect(resumed.snapshot().step).toBe(2); expect(resumed.snapshot().resumes).toBe(1);
  });
});
