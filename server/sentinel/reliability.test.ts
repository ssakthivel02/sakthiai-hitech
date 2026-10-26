import { describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";
import { router } from "../_core/trpc";
import type { TrpcContext } from "../_core/context";
import { createSentinelRouter } from "./router";
import type { SentinelRouterDeps } from "./router";
import { InMemorySentinelStore } from "./testing";
import { createSentinelInvestigateHandler } from "./handler";
import { FakeTools, fakeCtx, goodModel, ID, WS, newRow } from "./testkit";
import { McpReadOnlyClient, McpClientError } from "../connectors/mcp/client";
import { McpDiagnosticTransport } from "./adapters/mcpDiagnosticTransport";
import type { NormalizedResult } from "../connectors/mcp";

type T = { id: string; workspaceId: number; state: string; input: unknown; idempotencyKey?: string; attempt: number; maxAttempts: number; cancelRequested: boolean; failureClass: string | null; progressNote: null };
class Tasks {
  tasks = new Map<string, T>(); failCreate = 0;
  async create(i: { workspaceId: number; input?: unknown; idempotencyKey?: string; maxAttempts?: number }) {
    if (this.failCreate-- > 0) throw new Error("queue unavailable");
    const dup = [...this.tasks.values()].find((t) => t.workspaceId === i.workspaceId && i.idempotencyKey && t.idempotencyKey === i.idempotencyKey);
    if (dup) return { task: dup as never, created: false };
    const t: T = { id: `00000000-0000-4000-8000-${String(this.tasks.size + 1).padStart(12, "0")}`, workspaceId: i.workspaceId, state: "QUEUED", input: i.input, idempotencyKey: i.idempotencyKey, attempt: 0, maxAttempts: 3, cancelRequested: false, failureClass: null, progressNote: null };
    this.tasks.set(t.id, t); return { task: t as never, created: true };
  }
  async get(ws: number, id: string) { const t = this.tasks.get(id); return t && t.workspaceId === ws ? (t as never) : null; }
  async cancel(ws: number, id: string) { const t = this.tasks.get(id); if (!t || t.workspaceId !== ws) return null; if (t.state === "QUEUED") { t.state = "CANCELLED"; t.cancelRequested = true; } else if (t.state === "RUNNING") t.cancelRequested = true; return t as never; }
}
const CONNECTOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const mcp = { list: async () => [{ id: CONNECTOR, name: "syn", endpoint: "http://127.0.0.1:9100/mcp", enabled: true, hasSecret: false, allowedTools: null, timeoutMs: 8000, maxResponseBytes: 262144 }], discover: async () => ({ tools: [{ name: "search_logs" }, { name: "query_metrics" }] }) };
function harness() {
  const store = new InMemorySentinelStore(); const tasks = new Tasks();
  const deps: SentinelRouterDeps = {
    store: () => store, tasks: () => tasks as never, mcp: () => mcp, enabled: () => true, workerEnabled: () => true,
    requireWorkspace: async (u, w) => { if (w !== WS || u !== 1) throw new TRPCError({ code: "FORBIDDEN", message: "denied" }); return {}; }, isWorkspaceOwner: async () => true,
  };
  const api = router({ sentinel: createSentinelRouter(deps) });
  const as = api.createCaller({ req: {} as TrpcContext["req"], res: { headersSent: false, setHeader: vi.fn() } as unknown as TrpcContext["res"], requestId: "t", user: { id: 1, openId: "u1", name: "U", email: null, loginMethod: "oidc", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() } as never });
  return { store, tasks, api: as.sentinel };
}
const input = { workspaceId: WS, title: "Write failures", severity: "high" as const, service: "orders-db", description: "Writes fail", hosts: ["db-1"], bindings: [{ tool: "logs.search" as const, connectorId: CONNECTOR, mcpTool: "search_logs", targetParam: "service" }] };
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

describe("task <-> investigation reconciliation", () => {
  it("a row that was never queued is failed after the grace period, not left QUEUED forever; a young one is left alone", async () => {
    const h = harness();
    await h.store.create(newRow({ id: "11111111-1111-4111-8111-111111111111" })); await h.store.create(newRow({ id: "33333333-3333-4333-8333-333333333333" }));
    (h.store.rows.get("11111111-1111-4111-8111-111111111111") as { createdAt: Date }).createdAt = minutesAgo(10);
    (h.store.rows.get("33333333-3333-4333-8333-333333333333") as { createdAt: Date }).createdAt = minutesAgo(1);
    const page = await h.api.list({ workspaceId: WS });
    const by = Object.fromEntries(page.items.map((i) => [i.id, i.status]));
    expect(by["11111111-1111-4111-8111-111111111111"]).toBe("FAILED"); expect(by["33333333-3333-4333-8333-333333333333"]).toBe("QUEUED");
    const failed = await h.api.get({ workspaceId: WS, investigationId: "11111111-1111-4111-8111-111111111111" });
    expect(failed.investigation).toMatchObject({ status: "FAILED", stopReason: "ENQUEUE_INCOMPLETE" }); expect(failed.final).toBeNull();
  });

  it("a retried create (same idempotency key) finishes enqueueing a row whose task was never created", async () => {
    const h = harness();
    const a = await h.api.create({ ...input, idempotencyKey: "crash-key-0001" });
    // simulate the crash window: row exists, task link and task are gone
    const row = h.store.rows.get(a.investigationId)!; (row as { taskId: string | null }).taskId = null; h.tasks.tasks.clear();
    const b = await h.api.create({ ...input, idempotencyKey: "crash-key-0001" });
    expect(b).toMatchObject({ investigationId: a.investigationId, created: false }); expect(b.taskId).toBeTruthy();
    expect((await h.store.get(WS, a.investigationId))!.taskId).toBe(b.taskId); expect(h.tasks.tasks.size).toBe(1);
    expect(h.store.rows.size).toBe(1);
  });

  it("a failed enqueue is reported and the row is closed truthfully (not left QUEUED)", async () => {
    const h = harness(); h.tasks.failCreate = 1;
    await expect(h.api.create(input)).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    expect([...h.store.rows.values()].map((r) => [r.status, r.stopReason])).toEqual([["FAILED", "ENQUEUE_FAILED"]]);
  });

  it("export and get agree when the task failed but the row still says RUNNING", async () => {
    const h = harness(); const a = await h.api.create(input);
    await h.store.markRunning(WS, a.investigationId); const t = h.tasks.tasks.get(a.taskId!)!; t.state = "FAILED"; t.failureClass = "PROVIDER_UNAVAILABLE";
    const exp = await h.api.export({ workspaceId: WS, investigationId: a.investigationId, format: "json" });
    expect(JSON.parse(exp.content).investigation).toMatchObject({ status: "FAILED", stopReason: "TASK_PROVIDER_UNAVAILABLE" });
    expect((await h.api.get({ workspaceId: WS, investigationId: a.investigationId })).investigation.status).toBe("FAILED");
  });
});

describe("cancellation", () => {
  it("cancelling when the task no longer exists cancels the investigation instead of claiming a request is pending", async () => {
    const h = harness(); const a = await h.api.create(input); await h.store.markRunning(WS, a.investigationId); h.tasks.tasks.clear();
    expect(await h.api.cancel({ workspaceId: WS, investigationId: a.investigationId })).toEqual({ status: "CANCELLED", cancelRequested: true });
    expect((await h.store.get(WS, a.investigationId))!.status).toBe("CANCELLED");
  });
  it("cancelling after the task already failed reports FAILED, not 'cancel requested'", async () => {
    const h = harness(); const a = await h.api.create(input); await h.store.markRunning(WS, a.investigationId);
    const t = h.tasks.tasks.get(a.taskId!)!; t.state = "FAILED"; t.failureClass = "INTERNAL";
    expect(await h.api.cancel({ workspaceId: WS, investigationId: a.investigationId })).toEqual({ status: "FAILED", cancelRequested: false });
  });
  it("a cancelled worker run ends CANCELLED with its evidence kept and a verified chain", async () => {
    const store = new InMemorySentinelStore(); const r = await store.create(newRow()); await store.attachTask(r.workspaceId, r.id, "22222222-2222-4222-8222-222222222222");
    const { ctx, state } = fakeCtx({ onCheckpoint: (n) => { if (n === 2) state.cancelled = true; } });
    await expect(createSentinelInvestigateHandler({ store, mcp: { callTool: async () => { throw new Error("no"); } }, enabled: () => true, config: () => ({ policyTimeoutMs: 5000, toolAttemptTimeoutMs: 2000, maxModelCalls: 24, formatRetries: 1, cancelPollMs: 20 }), transportFor: () => new FakeTools(), modelFor: () => goodModel() })(ctx)).rejects.toThrow();
    const row = (await store.get(WS, ID))!;
    expect(row.status).toBe("CANCELLED"); expect(row.eventCount).toBeGreaterThan(0);
  });
});

describe("consistent snapshots", () => {
  it("get and export never pair a stale event list with the newer row: a count mismatch is re-read", async () => {
    const h = harness(); const a = await h.api.create(input);
    // Complete a real run for this investigation id/task, then make the FIRST event read return a stale prefix.
    const { ctx } = fakeCtx({ task: { id: a.taskId!, workspaceId: WS }, input: { investigationId: a.investigationId } });
    await createSentinelInvestigateHandler({ store: h.store, mcp: { callTool: async () => { throw new Error("no"); } }, enabled: () => true, config: () => ({ policyTimeoutMs: 5000, toolAttemptTimeoutMs: 2000, maxModelCalls: 24, formatRetries: 1, cancelPollMs: 20 }), transportFor: () => new FakeTools(), modelFor: () => goodModel() })(ctx);
    const full = await h.store.readEvents(WS, a.investigationId); expect(full.length).toBeGreaterThan(5);
    const real = h.store.readEvents.bind(h.store); let calls = 0;
    h.store.readEvents = async (...args: Parameters<typeof real>) => { const all = await real(...args); return calls++ === 0 ? all.slice(0, 2) : all; };
    const v = await h.api.get({ workspaceId: WS, investigationId: a.investigationId });
    expect(calls).toBe(2); expect(v.integrity).toMatchObject({ chainOk: true, complete: true, eventCount: full.length }); expect(v.final).not.toBeNull();
    calls = 0;
    const rep = JSON.parse((await h.api.export({ workspaceId: WS, investigationId: a.investigationId, format: "json" })).content);
    expect(calls).toBe(2); expect(rep.state).toBe("COMPLETE"); expect(rep.integrity).toMatchObject({ complete: true, eventCount: full.length });
  });
});

describe("connector call lifetime", () => {
  const hang = (seen: { aborted: boolean }): typeof fetch => ((_url: unknown, init?: RequestInit) => new Promise((_res, rej) => { init?.signal?.addEventListener("abort", () => { seen.aborted = true; const e = new Error("aborted"); e.name = "AbortError"; rej(e); }); })) as typeof fetch;
  it("an abort from the caller stops the in-flight request promptly and reports TIMEOUT", async () => {
    const seen = { aborted: false }; const ac = new AbortController();
    const client = new McpReadOnlyClient({ endpoint: "http://127.0.0.1:1/mcp", timeoutMs: 30_000, maxResponseBytes: 1000, fetchImpl: hang(seen), signal: ac.signal });
    const t0 = Date.now(); const p = client.initialize(); setTimeout(() => ac.abort(), 30);
    await expect(p).rejects.toMatchObject({ kind: "TIMEOUT", message: expect.stringMatching(/aborted by the caller/) });
    expect(seen.aborted).toBe(true); expect(Date.now() - t0).toBeLessThan(2000);
  });
  it("an already-aborted signal sends nothing", async () => {
    let sent = 0; const ac = new AbortController(); ac.abort();
    const client = new McpReadOnlyClient({ endpoint: "http://127.0.0.1:1/mcp", timeoutMs: 30_000, maxResponseBytes: 1000, fetchImpl: (async () => { sent++; return new Response("{}"); }) as typeof fetch, signal: ac.signal });
    await expect(client.initialize()).rejects.toBeInstanceOf(McpClientError); expect(sent).toBe(0);
  });
  it("the Sentinel adapter forwards the attempt's abort signal to the connector service and never starts a call for a dead attempt", async () => {
    const seen: Array<AbortSignal | undefined> = [];
    const res = { kind: "tool", text: "2026-10-01T09:55:00Z ERROR disk full", isError: false, truncated: false, ignoredNonTextParts: 0, provenance: { connectorName: "syn", retrievedAt: "2026-10-18T00:00:00Z" } } as unknown as NormalizedResult;
    const tr = new McpDiagnosticTransport({ service: { callTool: async (_a, _c, _t, _args, o) => { seen.push(o?.signal); return res; } }, workspaceId: WS, tenant: `ws-${WS}`, bindings: [{ tool: "logs.search", connectorId: CONNECTOR, mcpTool: "search_logs", targetParam: "service" }] });
    const live = new AbortController();
    expect((await tr.exec(`ws-${WS}`, "logs.search", "orders-db", { signal: live.signal })).kind).toBe("ok"); expect(seen[0]).toBe(live.signal);
    const dead = new AbortController(); dead.abort();
    expect((await tr.exec(`ws-${WS}`, "logs.search", "orders-db", { signal: dead.signal })).kind).toBe("timeout"); expect(seen).toHaveLength(1);
  });
});

describe("viewer capabilities for the UI", () => {
  it("status tells the UI who the viewer is so it can disable creator/owner-only actions (the server still enforces them)", async () => {
    const h = harness();
    expect((await h.api.status({ workspaceId: WS })).viewer).toEqual({ userId: 1, isOwner: true });
  });
});
