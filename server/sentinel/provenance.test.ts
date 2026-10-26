import { describe, expect, it } from "vitest";
import { TaskWorker } from "../tasks/worker";
import type { TaskRecord } from "../tasks/types";
import { modelCallMeta } from "../gateway/provenance";
import type { GatewayOutcome } from "../gateway/types";
import { TaskModelTransport, toProvenance } from "./taskModelTransport";
import { createSentinelInvestigateHandler } from "./handler";
import { InMemorySentinelStore } from "./testing";
import { MockModelTransport } from "./engine/model_transport";
import type { ModelResponse, ModelTransport } from "./engine/model_transport";
import { buildView } from "./view";
import { buildReport, renderHtml, renderMarkdown, describeModelIdentity } from "./report";
import { FakeTools, ID, WS, fakeCtx, goodModel, newRow, task } from "./testkit";

const SECRET = "sk-live-SUPERSECRET-9999";
const returned = (over: Partial<Extract<GatewayOutcome, { status: "returned" }>> = {}): Extract<GatewayOutcome, { status: "returned" }> => ({
  status: "returned", content: "hello", providerId: "local-openai-compatible", modelId: "qwen2.5-7b-instruct", profileId: "sakthi-local-general", kind: "self_hosted", billingMode: "local_compute",
  usage: { source: "provider_reported", promptTokens: 120, completionTokens: 30, totalTokens: 150 }, attempts: [{ providerId: "local-openai-compatible", outcome: "ok", httpAttempts: 1, latencyMs: 41 }], latencyMs: 44, ...over,
});

describe("gateway call metadata is safe and truthful", () => {
  it("carries identity, usage and attempts but never an endpoint, key, prompt or reply", () => {
    const o = { ...returned(), baseUrl: `https://u:${SECRET}@example.invalid`, apiKey: SECRET, headers: { authorization: SECRET } } as unknown as Extract<GatewayOutcome, { status: "returned" }>;
    const m = modelCallMeta(o); const text = JSON.stringify(m);
    expect(m).toMatchObject({ providerId: "local-openai-compatible", modelId: "qwen2.5-7b-instruct", configSource: "env:LOCAL_LLM_*", providerKind: "self_hosted", billingMode: "local_compute" });
    expect(text).not.toContain(SECRET); expect(text).not.toContain("example.invalid"); expect(text).not.toContain("hello");
  });
  it("sanitises hostile identifiers and labels unknown providers as such", () => {
    const m = modelCallMeta(returned({ providerId: "weird\u0000<script>", modelId: "m".repeat(500) }));
    expect(m.providerId).not.toMatch(/[<>\u0000]/); expect(m.modelId.length).toBeLessThanOrEqual(96); expect(m.configSource).toBe("unknown");
    expect(modelCallMeta(returned({ providerId: "external-openai-compatible", kind: "external", billingMode: "metered_api" })).configSource).toBe("env:LLM_*");
  });
});

describe("TaskWorker.invokeModelDetailed", () => {
  it("returns the governed content plus provider metadata, pins the tenant, and keeps invokeModel unchanged", async () => {
    const t = task({ workspaceId: 7 });
    let claimed = false;
    const store: any = { claim: async () => (claimed ? null : ((claimed = true), t)), heartbeat: async () => ({ ok: true, cancelRequested: false }), complete: async () => true, checkpoint: async () => ({ ok: true, cancelRequested: false }) };
    const seen: any[] = []; const results: any[] = [];
    const gateway = { invoke: async (r: any) => { seen.push(r); return returned(); } };
    const worker = new TaskWorker({ store, gateway, handlers: { "sentinel.investigate": async (ctx) => {
      results.push(await ctx.invokeModelDetailed({ messages: [{ role: "user", content: "x" }] }), await ctx.invokeModel({ messages: [{ role: "user", content: "y" }] }));
    } } });
    expect((await worker.runOnce()).status).toBe("succeeded");
    expect(seen.every((r) => r.workspaceId === 7)).toBe(true);
    expect(results[0].content).toBe("hello"); expect(results[0].meta.modelId).toBe("qwen2.5-7b-instruct"); expect(results[1]).toBe("hello");
  });
});

describe("a partial gateway port never breaks the governed call", () => {
  it("content is still returned and identity is simply unavailable (null), never invented", async () => {
    const t = task({ workspaceId: 7 }); let claimed = false; const got: any[] = [];
    const store: any = { claim: async () => (claimed ? null : ((claimed = true), t)), heartbeat: async () => ({ ok: true, cancelRequested: false }), complete: async () => true, checkpoint: async () => ({ ok: true, cancelRequested: false }) };
    const gateway = { invoke: async () => ({ status: "returned", content: "ok [1]", providerId: "p", attempts: [], latencyMs: 1 }) as never };
    const worker = new TaskWorker({ store, gateway, handlers: { "sentinel.investigate": async (ctx) => { got.push(await ctx.invokeModel({ messages: [{ role: "user", content: "x" }] }), await ctx.invokeModelDetailed({ messages: [{ role: "user", content: "x" }] })); } } });
    expect((await worker.runOnce()).status).toBe("succeeded");
    expect(got[0]).toBe("ok [1]"); expect(got[1]).toEqual({ content: "ok [1]", meta: null });
    const r = await new TaskModelTransport({ throwIfCancelled: () => undefined, invokeModel: async () => "x", invokeModelDetailed: async () => ({ content: "x", meta: null }) }).complete({ system: "s", user: "u", attempt: 0 });
    expect(r).toEqual({ text: "x" });
  });
});

describe("TaskModelTransport", () => {
  it("attaches provenance when the context can supply it and omits it (never invents it) otherwise", async () => {
    const base = { throwIfCancelled: () => undefined };
    const detailed = new TaskModelTransport({ ...base, invokeModel: async () => "plain", invokeModelDetailed: async () => ({ content: "d", meta: modelCallMeta(returned()) }) });
    const r = await detailed.complete({ system: "s", user: "u", attempt: 0 });
    expect(r.provenance).toMatchObject({ provider_id: "local-openai-compatible", model_id: "qwen2.5-7b-instruct" }); expect(r.tokens_in).toBe(120); expect(r.tokens_out).toBe(30);
    const legacy = await new TaskModelTransport({ ...base, invokeModel: async () => "plain" }).complete({ system: "s", user: "u", attempt: 0 });
    expect(legacy).toEqual({ text: "plain" });
    expect(toProvenance(modelCallMeta(returned())).gateway_attempts[0]).toEqual({ provider_id: "local-openai-compatible", outcome: "ok", http_attempts: 1, latency_ms: 41 });
  });
});

/** goodModel with identity attached, standing in for TaskModelTransport over a gateway that reports it. */
const identified = (identity: boolean, onlyFirst = false): ModelTransport => {
  const inner = goodModel(); let n = 0;
  return { id: "gateway", kind: "remote", async complete(req): Promise<ModelResponse> {
    const r = await inner.complete(req); n++;
    const m = modelCallMeta(returned());
    return identity && (!onlyFirst || n === 1) ? { text: r.text, tokens_in: m.usage.promptTokens, tokens_out: m.usage.completionTokens, provenance: toProvenance(m) } : { text: r.text };
  } };
};
const run = async (model: ModelTransport) => {
  const store = new InMemorySentinelStore(); const r = await store.create(newRow()); await store.attachTask(r.workspaceId, r.id, "22222222-2222-4222-8222-222222222222");
  const { ctx } = fakeCtx();
  await createSentinelInvestigateHandler({ store, mcp: { callTool: async () => { throw new Error("no mcp"); } }, enabled: () => true, config: () => ({ policyTimeoutMs: 5000, toolAttemptTimeoutMs: 2000, maxModelCalls: 24, formatRetries: 1, cancelPollMs: 20 }), transportFor: () => new FakeTools(), modelFor: () => model as never })(ctx);
  const row = (await store.get(WS, ID))!; const events = await store.readEvents(WS, ID);
  return { view: buildView(row, events), events };
};

describe("provenance persisted in the trace and shown in the report", () => {
  it("REPORTED: identity is stored in the hash-chained events and survives into view and report (json, markdown, html)", async () => {
    const { view, events } = await run(identified(true));
    expect(JSON.stringify(events)).toContain("qwen2.5-7b-instruct");
    expect(view.integrity.chainOk).toBe(true); expect(view.integrity.complete).toBe(true);
    expect(view.modelIdentity).toMatchObject({ status: "REPORTED", decisions: 3, identified: 3, models: [{ modelId: "qwen2.5-7b-instruct", decisions: 3 }] });
    expect(view.modelIdentity.tokens?.prompt).toBe(360);
    const rep = buildReport(view, new Date("2026-10-18T00:00:00Z"));
    expect(rep.runtime.providerIdentityCaptured).toBe(true);
    const md = renderMarkdown(rep), html = renderHtml(rep);
    for (const out of [md, html]) { expect(out).toContain("qwen2.5-7b-instruct"); expect(out).toContain("sakthi-local-general"); expect(out).not.toContain(SECRET); }
    expect(describeModelIdentity(view.modelIdentity)).toMatch(/configured via env:LOCAL_LLM_\*/);
  });
  it("UNVERIFIED: no identity from the transport means the report says UNVERIFIED and names no model", async () => {
    const { view } = await run(identified(false));
    expect(view.modelIdentity).toMatchObject({ status: "UNVERIFIED", identified: 0, models: [] });
    const rep = buildReport(view); const md = renderMarkdown(rep);
    expect(rep.runtime.providerIdentityCaptured).toBe(false); expect(md).toContain("Model identity: UNVERIFIED"); expect(renderHtml(rep)).toContain("UNVERIFIED");
  });
  it("PARTIAL: a mixed trace is labelled partial, not fully identified", async () => {
    const { view } = await run(identified(true, true));
    expect(view.modelIdentity).toMatchObject({ status: "PARTIAL", decisions: 3, identified: 1 });
    expect(describeModelIdentity(view.modelIdentity)).toContain("2 decision(s) UNVERIFIED");
  });
  it("a mock transport never produces an identity", async () => {
    const { view } = await run(goodModel() as MockModelTransport);
    expect(view.modelIdentity.status).toBe("UNVERIFIED");
  });
  it("a malformed stored provenance is ignored rather than trusted, and the tamper shows in the integrity check", async () => {
    const store = new InMemorySentinelStore(); const r = await store.create(newRow()); await store.attachTask(r.workspaceId, r.id, "22222222-2222-4222-8222-222222222222");
    const { ctx } = fakeCtx();
    await createSentinelInvestigateHandler({ store, mcp: { callTool: async () => { throw new Error("no mcp"); } }, enabled: () => true, config: () => ({ policyTimeoutMs: 5000, toolAttemptTimeoutMs: 2000, maxModelCalls: 24, formatRetries: 1, cancelPollMs: 20 }), transportFor: () => new FakeTools(), modelFor: () => identified(true) as never })(ctx);
    const events = (await store.readEvents(WS, ID)).map((e) => (e.type === "decision" ? { ...e, payload: { ...(e.payload as object), model_meta: { ...(e.payload as any).model_meta, provenance: { provider_id: 5, model_id: { evil: true } } } } } : e));
    const view = buildView((await store.get(WS, ID))!, events);
    expect(view.modelIdentity.status).toBe("UNVERIFIED"); expect(view.integrity.chainOk).toBe(false);
  });
});

describe("extended provenance (hosted runtime, correlation, timestamp, fallback, cost) reaches the view and report", () => {
  it("is persisted in the trace, parsed defensively, summarised, and rendered without endpoints or keys", async () => {
    const hosted = returned({ providerId: "external-openai-compatible", modelId: "sarvam-105b", profileId: "frontier-external-reference", kind: "external", billingMode: "metered_api", endpointProfile: "sarvam-chat",
      usage: { source: "provider_reported", promptTokens: 100, completionTokens: 50, totalTokens: 150, cost: { amount: 0.0045, unit: "INR", basis: "configured_rate", estimated: false } },
      attempts: [{ providerId: "local-openai-compatible", outcome: "timeout" }, { providerId: "external-openai-compatible", outcome: "ok", httpAttempts: 1, latencyMs: 90 }] });
    const inner = goodModel();
    const model: ModelTransport = { id: "gateway", kind: "remote", async complete(req) { const r = await inner.complete(req); const m = modelCallMeta(hosted, { requestId: "task-1:1", invokedAt: Date.UTC(2026, 9, 18, 6, 0, 0) })!; return { text: r.text, tokens_in: m.usage.promptTokens, tokens_out: m.usage.completionTokens, provenance: toProvenance(m) }; } };
    const { view } = await run(model);
    const mi = view.modelIdentity;
    expect(mi.status).toBe("REPORTED");
    expect(mi.models[0]).toMatchObject({ modelId: "sarvam-105b", runtimeClass: "hosted", endpointProfile: "sarvam-chat" });
    expect(mi.fallbackDecisions).toBe(3);
    expect(mi.cost).toEqual({ amount: 0.0135, unit: "INR", estimated: false });
    const d = view.decisions.find((x) => x.model)!.model!.provenance!;
    expect(d).toMatchObject({ invokedAt: "2026-10-18T06:00:00.000Z", correlationId: "task-1:1", verification: "gateway_reported", fallbackOccurred: true });
    const line = describeModelIdentity(mi);
    expect(line).toContain("hosted"); expect(line).toContain("endpoint profile sarvam-chat"); expect(line).toContain("0.0135 INR"); expect(line).toContain("not an invoice");
    const out = renderMarkdown(buildReport(view)) + renderHtml(buildReport(view));
    expect(out).not.toMatch(/sarvam\.ai|sk-/);
  });
  it("fields the caller did not supply stay null (no invented timestamp, correlation id or cost)", async () => {
    const { view } = await run(identified(true));
    const p = view.decisions.find((x) => x.model)!.model!.provenance!;
    expect(p.invokedAt).toBeNull(); expect(p.correlationId).toBeNull();
    expect(p.fallbackOccurred).toBe(false); // the ok-only attempt list is real data from this call
    expect(view.modelIdentity.cost).toBeNull();
  });
});
