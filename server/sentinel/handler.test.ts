import { describe, expect, it } from "vitest";
import { createSentinelInvestigateHandler } from "./handler";
import type { SentinelHandlerDeps } from "./handler";
import { InMemorySentinelStore } from "./testing";
import { MockModelTransport } from "./engine/model_transport";
import { TaskCancelledError, TaskFatalError, TaskLeaseLostError, TaskRetryableError } from "../tasks/types";
import { verifyTrace } from "./engine/trace";
import type { InvestigationRecord } from "./types";
import { tenantOf } from "./config";
import { FakeTools, ID, OTHER_WS, WS, fakeCtx, goodModel, hyp, newRow, ridsIn } from "./testkit";

const deps = (store: InMemorySentinelStore, over: Partial<SentinelHandlerDeps> = {}): SentinelHandlerDeps => ({
  store, mcp: { callTool: async () => { throw new Error("mcp must not be used"); } }, enabled: () => true,
  config: () => ({ policyTimeoutMs: 5000, toolAttemptTimeoutMs: 2000, maxModelCalls: 24, formatRetries: 1, cancelPollMs: 20 }), ...over,
});
const seed = async (store: InMemorySentinelStore, over: Partial<InvestigationRecord> = {}) => { const r = await store.create(newRow(over)); await store.attachTask(r.workspaceId, r.id, "22222222-2222-4222-8222-222222222222"); return r; };

describe("sentinel.investigate handler", () => {
  it("runs an investigation end to end, persists a verified hash-chained trace and finalises the row", async () => {
    const store = new InMemorySentinelStore(); await seed(store);
    const tools = new FakeTools(); const model = goodModel();
    const { ctx, state } = fakeCtx();
    const out = await createSentinelInvestigateHandler(deps(store, { transportFor: () => tools, modelFor: () => model }))(ctx) as { status: string; label: string; verified: boolean };
    expect(out.status).toBe("COMPLETED"); expect(out.label).toBe("DISK_FULL"); expect(out.verified).toBe(true);
    const row = (await store.get(WS, ID))!;
    expect(row.status).toBe("COMPLETED"); expect(row.outcome).toBe("DIAGNOSIS"); expect(row.eventCount).toBeGreaterThan(5);
    const events = await store.readEvents(WS, ID);
    expect(verifyTrace(events, ID).ok).toBe(true);
    expect(events.map((e) => e.type)).toContain("final");
    expect(tools.calls.map((c) => c.tool)).toEqual(["logs.search", "metrics.query"]);
    expect(tools.calls.every((c) => c.tenant === tenantOf(WS))).toBe(true);
    expect(state.checkpoints).toBeGreaterThan(2);
    const fin = events.find((e) => e.type === "final")!.payload as { remediation: { executed: boolean; requires_approval: boolean } };
    expect(fin.remediation).toMatchObject({ executed: false, requires_approval: true });
  });

  it("does not reset the model-call allowance after a retryable provider failure", async () => {
    const store = new InMemorySentinelStore(); await seed(store);
    let calls = 0;
    const error = new TaskRetryableError("provider unavailable", "PROVIDER_UNAVAILABLE");
    const model = { id: "failing", kind: "mock" as const, lastError: error, complete: async () => { calls++; throw error; } };
    const handler = createSentinelInvestigateHandler(deps(store, {
      config: () => ({ policyTimeoutMs: 5000, toolAttemptTimeoutMs: 2000, maxModelCalls: 1, formatRetries: 0, cancelPollMs: 20 }),
      transportFor: () => new FakeTools(), modelFor: () => model,
    }));
    const first = fakeCtx({ task: { maxAttempts: 2 } });
    await expect(handler(first.ctx)).rejects.toBeInstanceOf(TaskRetryableError);
    expect(calls).toBe(1);
    const second = fakeCtx({ attempt: 2, task: { maxAttempts: 2 }, checkpoint: first.state.savedCheckpoint });
    await handler(second.ctx);
    expect(calls).toBe(1);
    expect((await store.get(WS, ID))!.status).toBe("FAILED");
  });

  it("never sends a request when the durable allowance is already exhausted", async () => {
    const store = new InMemorySentinelStore(); await seed(store);
    const model = goodModel();
    const retry = fakeCtx({ attempt: 2, checkpoint: { investigationId: ID, seq: 0, traceHead: null, modelCalls: 1 } });
    const out = await createSentinelInvestigateHandler(deps(store, {
      config: () => ({ policyTimeoutMs: 5000, toolAttemptTimeoutMs: 2000, maxModelCalls: 1, formatRetries: 0, cancelPollMs: 20 }),
      transportFor: () => new FakeTools(), modelFor: () => model,
    }))(retry.ctx) as { status: string };
    expect(out.status).toBe("FAILED"); expect(model.calls).toHaveLength(0);
  });

  it("fails closed for legacy or invalid active budget checkpoints", async () => {
    for (const budget of [undefined, -1, 1.5, "1"]) {
      const store = new InMemorySentinelStore(); await seed(store);
      const model = goodModel();
      const retry = fakeCtx({ attempt: 2, checkpoint: { investigationId: ID, seq: 0, traceHead: null, ...(budget !== undefined ? { modelCalls: budget } : {}) } });
      await expect(createSentinelInvestigateHandler(deps(store, { modelFor: () => model }))(retry.ctx)).rejects.toBeInstanceOf(TaskFatalError);
      expect(model.calls).toHaveLength(0);
    }
  });

  it("reserves durably before dispatch and never refunds an ambiguous crash reservation", async () => {
    const store = new InMemorySentinelStore(); await seed(store);
    const model = goodModel(); const first = fakeCtx();
    const save = first.ctx.saveCheckpoint;
    first.ctx.saveCheckpoint = async (data, progress) => {
      await save(data, progress);
      if ((data as { modelCalls?: number }).modelCalls === 1) {
        first.state.lost = true;
        throw new TaskLeaseLostError();
      }
    };
    const handler = createSentinelInvestigateHandler(deps(store, {
      config: () => ({ policyTimeoutMs: 5000, toolAttemptTimeoutMs: 2000, maxModelCalls: 1, formatRetries: 0, cancelPollMs: 20 }),
      transportFor: () => new FakeTools(), modelFor: () => model,
    }));
    await expect(handler(first.ctx)).rejects.toBeInstanceOf(TaskLeaseLostError);
    expect(model.calls).toHaveLength(0);
    expect((first.state.savedCheckpoint as { modelCalls: number }).modelCalls).toBe(1);
    await handler(fakeCtx({ attempt: 2, checkpoint: first.state.savedCheckpoint }).ctx);
    expect(model.calls).toHaveLength(0);
  });

  it("is default-disabled", async () => {
    const store = new InMemorySentinelStore(); await seed(store);
    const { ctx } = fakeCtx();
    await expect(createSentinelInvestigateHandler({ store, mcp: { callTool: async () => { throw new Error("x"); } }, enabled: () => false })(ctx)).rejects.toBeInstanceOf(TaskFatalError);
    expect((await store.readEvents(WS, ID)).length).toBe(0);
  });

  it("never reads an investigation from another workspace and rejects a payload with extra fields", async () => {
    const store = new InMemorySentinelStore(); await seed(store);
    const a = fakeCtx({ task: { workspaceId: OTHER_WS } });
    await expect(createSentinelInvestigateHandler(deps(store, { transportFor: () => new FakeTools(), modelFor: () => goodModel() }))(a.ctx)).rejects.toThrow(/not found in task workspace/);
    const b = fakeCtx({ input: { investigationId: ID, workspaceId: OTHER_WS } });
    await expect(createSentinelInvestigateHandler(deps(store))(b.ctx)).rejects.toThrow(/invalid sentinel.investigate input/);
    expect((await store.readEvents(WS, ID)).length).toBe(0);
  });

  it("resumes from stored events after a crash without repeating completed tool calls", async () => {
    const store = new InMemorySentinelStore(); await seed(store);
    const tools1 = new FakeTools();
    const crash = fakeCtx({ onCheckpoint: async (_n, data) => {
      const old = await store.readEvents(WS, ID);
      if (old.some(e => e.type === "tool_result") && (data as { seq: number }).seq > old.length) throw new Error("simulated process crash");
    } });
    await expect(createSentinelInvestigateHandler(deps(store, { transportFor: () => tools1, modelFor: () => goodModel() }))(crash.ctx)).rejects.toThrow(/simulated process crash/);
    const mid = await store.readEvents(WS, ID);
    expect(mid.length).toBeGreaterThan(0); expect((await store.get(WS, ID))!.status).toBe("RUNNING");
    const doneBefore = mid.filter((e) => e.type === "tool_result").length;
    expect(doneBefore).toBeGreaterThanOrEqual(1);

    const inconsistent = fakeCtx({ attempt: 2, checkpoint: { ...(crash.state.savedCheckpoint as object), modelCalls: 0 } });
    const denied = goodModel();
    await expect(createSentinelInvestigateHandler(deps(store, { modelFor: () => denied }))(inconsistent.ctx)).rejects.toBeInstanceOf(TaskFatalError);
    expect(denied.calls).toHaveLength(0);

    const tools2 = new FakeTools(); tools2.n = 100;
    const second = fakeCtx({ attempt: 2, checkpoint: crash.state.savedCheckpoint });
    const out = await createSentinelInvestigateHandler(deps(store, { transportFor: () => tools2, modelFor: () => goodModel() }))(second.ctx) as { status: string };
    expect(out.status).toBe("COMPLETED");
    const events = await store.readEvents(WS, ID);
    expect(verifyTrace(events, ID).ok).toBe(true);
    expect(events.filter((e) => e.type === "resumed").length).toBe(1);
    expect(tools1.calls.length + tools2.calls.length).toBe(2 + (mid[mid.length - 1]!.type === "tool_request" ? 1 : 0));
    expect((crash.state.savedCheckpoint as { modelCalls: number }).modelCalls).toBe(2);
  });

  it("finishes from stored terminal events without running anything (crash between append and finalise)", async () => {
    const store = new InMemorySentinelStore(); await seed(store);
    const first = fakeCtx();
    await createSentinelInvestigateHandler(deps(store, { transportFor: () => new FakeTools(), modelFor: () => goodModel() }))(first.ctx);
    // simulate a crash after events were appended but before the row was finalised
    const row = (store.rows.get(ID))!; row.status = "RUNNING"; row.outcome = null; row.label = null; row.finishedAt = null;
    let used = 0;
    const again = fakeCtx({ attempt: 2 });
    const out = await createSentinelInvestigateHandler(deps(store, { transportFor: () => { used++; return new FakeTools(); }, modelFor: () => { used++; return goodModel(); } }))(again.ctx) as { status: string };
    expect(out.status).toBe("COMPLETED"); expect(used).toBe(0);
    expect((await store.get(WS, ID))!.label).toBe("DISK_FULL");
  });

  it("cancellation: stops, persists a verifiable cancelled trace and surfaces TaskCancelledError", async () => {
    const store = new InMemorySentinelStore(); await seed(store);
    const { ctx, state } = fakeCtx();
    const slowModel = new MockModelTransport(async (req) => {
      const rids = ridsIn(req.user);
      if (rids.length === 0) return JSON.stringify({ type: "CALL", tool: "logs.search", target: "orders-db", rationale: "start", hypotheses: hyp([], 0.4) });
      state.cancelled = true;                      // operator cancels while the model is thinking
      await new Promise((r) => setTimeout(r, 400));
      return JSON.stringify({ type: "CALL", tool: "metrics.query", target: "db-1", rationale: "late", hypotheses: hyp([rids[0]!], 0.6) });
    });
    const tools = new FakeTools();
    await expect(createSentinelInvestigateHandler(deps(store, { transportFor: () => tools, modelFor: () => slowModel }))(ctx)).rejects.toBeInstanceOf(TaskCancelledError);
    const row = (await store.get(WS, ID))!;
    expect(row.status).toBe("CANCELLED"); expect(row.stopReason).toBe("CANCELLED");
    const events = await store.readEvents(WS, ID);
    expect(verifyTrace(events, ID).ok).toBe(true);
    expect(events.some((e) => e.type === "cancelled")).toBe(true);
    expect(tools.calls.length).toBe(1);
  });

  it("lease loss writes nothing further and propagates", async () => {
    const store = new InMemorySentinelStore(); await seed(store);
    const { ctx, state } = fakeCtx({ onCheckpoint: (c) => { if (c === 2) state.lost = true; } });
    await expect(createSentinelInvestigateHandler(deps(store, { transportFor: () => new FakeTools(), modelFor: () => goodModel() }))(ctx)).rejects.toBeInstanceOf(TaskLeaseLostError);
    const row = (await store.get(WS, ID))!;
    expect(["RUNNING", "QUEUED"]).toContain(row.status);
    const events = await store.readEvents(WS, ID);
    expect(events.some((e) => e.type === "run_end")).toBe(false);
  });

  it("retryable provider failure with attempts left rethrows for backoff and records no terminal outcome", async () => {
    const store = new InMemorySentinelStore(); await seed(store);
    const failing = Object.assign(new MockModelTransport(() => { throw new TaskRetryableError("model provider unavailable (timeout)", "PROVIDER_UNAVAILABLE"); }), { lastError: null as TaskRetryableError | null });
    const wrapped = { id: failing.id, kind: failing.kind, get lastError() { return failing.lastError; }, complete: async (r: Parameters<typeof failing.complete>[0]) => { try { return await failing.complete(r); } catch (e) { failing.lastError = e as TaskRetryableError; throw e; } } };
    const { ctx } = fakeCtx({ attempt: 1 });
    await expect(createSentinelInvestigateHandler(deps(store, { transportFor: () => new FakeTools(), modelFor: () => wrapped }))(ctx)).rejects.toBeInstanceOf(TaskRetryableError);
    const row = (await store.get(WS, ID))!;
    expect(row.status).toBe("RUNNING");
    expect((await store.readEvents(WS, ID)).some((e) => e.type === "run_end")).toBe(false);
  });

  it("on the final attempt a provider failure becomes a truthful FAILED outcome, not a diagnosis", async () => {
    const store = new InMemorySentinelStore(); await seed(store);
    const failing = { id: "x", kind: "remote" as const, lastError: null as TaskRetryableError | null, complete: async (): Promise<never> => { const e = new TaskRetryableError("model provider unavailable (timeout)", "PROVIDER_UNAVAILABLE"); failing.lastError = e; throw e; } };
    const { ctx } = fakeCtx({ attempt: 3 });
    const out = await createSentinelInvestigateHandler(deps(store, { transportFor: () => new FakeTools(), modelFor: () => failing }))(ctx) as { status: string; outcome: string };
    expect(out.status).toBe("FAILED"); expect(out.outcome).toBe("ABSTAIN");
    const row = (await store.get(WS, ID))!;
    expect(row.status).toBe("FAILED"); expect(row.label).toBe("INCONCLUSIVE");
  });

  it("a write-tool request from the model is denied by the broker and never reaches the adapter", async () => {
    const store = new InMemorySentinelStore(); await seed(store, { allowedTools: ["logs.search", "metrics.query", "service.restart" as never] });
    const tools = new FakeTools();
    const model = new MockModelTransport((req) => {
      const h = (JSON.parse(req.user) as { history: unknown[] }).history;
      if (h.length === 0) return JSON.stringify({ type: "CALL", tool: "service.restart", target: "orders-db", rationale: "just restart it", hypotheses: hyp([], 0.4) });
      return JSON.stringify({ type: "FINAL", outcome: "ABSTAIN", label: "INCONCLUSIVE", summary: "Insufficient evidence.", cited: [], contradictions: [], confidence: 0.1, remediation_proposal: "None.", next_safe_steps: ["Collect logs"], hypotheses: [] });
    });
    const { ctx } = fakeCtx();
    const out = await createSentinelInvestigateHandler(deps(store, { transportFor: () => tools, modelFor: () => model }))(ctx) as { status: string };
    expect(tools.calls.length).toBe(0);
    const events = await store.readEvents(WS, ID);
    const tr = events.find((e) => e.type === "tool_result")!.payload as { status: string; deny_reason: string };
    expect(tr.status).toBe("DENIED"); expect(tr.deny_reason).toBe("WRITE_TOOLS_DISABLED");
    expect(out.status).toBe("ABSTAINED");
  });
});
