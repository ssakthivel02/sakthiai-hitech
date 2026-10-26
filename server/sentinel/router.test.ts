import { describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";
import { router } from "../_core/trpc";
import type { TrpcContext } from "../_core/context";
import { createSentinelRouter } from "./router";
import type { SentinelRouterDeps } from "./router";
import { InMemorySentinelStore } from "./testing";
import { createSentinelInvestigateHandler } from "./handler";
import { FakeTools, fakeCtx, goodModel, ID, WS } from "./testkit";
import type { BindingCatalog } from "./adapters/contract";

const CONNECTOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FOREIGN_CONNECTOR = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DISABLED_CONNECTOR = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

class FakeTasks {
  tasks = new Map<string, { id: string; workspaceId: number; state: string; input: unknown; idempotencyKey?: string; attempt: number; maxAttempts: number; cancelRequested: boolean; failureClass: string | null; progressNote: null }>();
  async create(i: { workspaceId: number; type: string; input?: unknown; idempotencyKey?: string; maxAttempts?: number }) {
    const dup = [...this.tasks.values()].find((t) => t.workspaceId === i.workspaceId && t.idempotencyKey === i.idempotencyKey && i.idempotencyKey);
    if (dup) return { task: dup as never, created: false };
    const t = { id: `00000000-0000-4000-8000-${String(this.tasks.size + 1).padStart(12, "0")}`, workspaceId: i.workspaceId, state: "QUEUED", input: i.input, idempotencyKey: i.idempotencyKey, attempt: 0, maxAttempts: i.maxAttempts ?? 3, cancelRequested: false, failureClass: null, progressNote: null } as const;
    this.tasks.set(t.id, { ...t });
    return { task: t as never, created: true };
  }
  async get(ws: number, id: string) { const t = this.tasks.get(id); return t && t.workspaceId === ws ? (t as never) : null; }
  async cancel(ws: number, id: string) {
    const t = this.tasks.get(id); if (!t || t.workspaceId !== ws) return null;
    if (t.state === "QUEUED") { t.state = "CANCELLED"; t.cancelRequested = true; } else if (t.state === "RUNNING") t.cancelRequested = true;
    return t as never;
  }
}

const view = (id: string, name: string, endpoint: string, enabled: boolean) => ({ id, name, endpoint, enabled, hasSecret: false, allowedTools: null, timeoutMs: 8000, maxResponseBytes: 262144 });
const catalogFor = (workspaceId: number): Omit<BindingCatalog, "list"> & { list(ws: number): Promise<ReturnType<typeof view>[]> } => ({
  list: async (ws) => (ws === workspaceId ? [view(CONNECTOR, "synthetic-diag", "http://127.0.0.1:9100/mcp", true), view(DISABLED_CONNECTOR, "prod-monitoring", "https://monitoring.example.com/mcp", false)] : []),
  discover: async () => ({ tools: [{ name: "search_logs" }, { name: "query_metrics" }] }),
});

function harness(opts: { enabled?: boolean; worker?: boolean; members?: Record<number, number[]>; owners?: Record<number, number[]> } = {}) {
  const store = new InMemorySentinelStore(); const tasks = new FakeTasks();
  const members = opts.members ?? { 1: [WS], 2: [WS], 3: [8] }; const owners = opts.owners ?? { 1: [WS] };
  const deps: SentinelRouterDeps = {
    store: () => store, tasks: () => tasks as never, mcp: () => catalogFor(WS), enabled: () => opts.enabled ?? true, workerEnabled: () => opts.worker ?? true,
    requireWorkspace: async (u, w) => { if (!members[u]?.includes(w)) throw new TRPCError({ code: "FORBIDDEN", message: "Workspace access denied" }); return {}; },
    isWorkspaceOwner: async (u, w) => !!owners[u]?.includes(w),
  };
  const api = router({ sentinel: createSentinelRouter(deps) });
  const as = (userId: number) => api.createCaller({ req: {} as TrpcContext["req"], res: { headersSent: false, setHeader: vi.fn() } as unknown as TrpcContext["res"], requestId: "t", user: { id: userId, openId: `u${userId}`, name: "U", email: null, loginMethod: "oidc", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() } }).sentinel;
  return { store, tasks, as };
}

const base = {
  workspaceId: WS, title: "Write failures on orders-db", severity: "high" as const, service: "orders-db", description: "Writes fail intermittently since 09:50", hosts: ["db-1"],
  bindings: [
    { tool: "logs.search" as const, connectorId: CONNECTOR, mcpTool: "search_logs", targetParam: "service", queryParam: "q" },
    { tool: "metrics.query" as const, connectorId: CONNECTOR, mcpTool: "query_metrics", targetParam: "host" },
  ],
};

describe("sentinel router", () => {
  it("is default-disabled and says so honestly; create is refused", async () => {
    const h = harness({ enabled: false });
    expect(await h.as(1).status({ workspaceId: WS })).toMatchObject({ enabled: false });
    await expect(h.as(1).create(base)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(h.store.rows.size).toBe(0); expect(h.tasks.tasks.size).toBe(0);
  });

  it("refuses to create when the task worker is not enabled (it would never run)", async () => {
    const h = harness({ worker: false });
    await expect(h.as(1).create(base)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("creates a QUEUED investigation + task whose payload is only the investigation id; audits; idempotent retry returns the same one", async () => {
    const h = harness();
    const a = await h.as(1).create({ ...base, idempotencyKey: "retry-key-0001" });
    expect(a.created).toBe(true);
    const row = (await h.store.get(WS, a.investigationId))!;
    expect(row.status).toBe("QUEUED"); expect(row.taskId).toBe(a.taskId); expect(row.allowedTools.sort()).toEqual(["logs.search", "metrics.query"]);
    expect(row.inventory).toEqual({ services: ["orders-db"], hosts: ["db-1"] });
    const task = h.tasks.tasks.get(a.taskId!)!;
    expect(task.input).toEqual({ investigationId: a.investigationId });
    expect(h.store.audit.map((x) => x.action)).toEqual(["CREATE"]);
    const b = await h.as(1).create({ ...base, idempotencyKey: "retry-key-0001" });
    expect(b).toMatchObject({ investigationId: a.investigationId, created: false }); expect(h.store.rows.size).toBe(1); expect(h.tasks.tasks.size).toBe(1);
  });

  it("rejects write tools, foreign/disabled connectors and MCP tools the connector does not expose", async () => {
    const h = harness();
    await expect(h.as(1).create({ ...base, bindings: [{ ...base.bindings[0]!, tool: "service.restart" as never }] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(h.as(1).create({ ...base, bindings: [{ ...base.bindings[0]!, connectorId: FOREIGN_CONNECTOR }] })).rejects.toMatchObject({ code: "BAD_REQUEST", message: "connector not found in this workspace" });
    await expect(h.as(1).create({ ...base, bindings: [{ ...base.bindings[0]!, connectorId: DISABLED_CONNECTOR }] })).rejects.toMatchObject({ code: "BAD_REQUEST", message: "connector is disabled" });
    await expect(h.as(1).create({ ...base, bindings: [{ ...base.bindings[0]!, mcpTool: "delete_everything" }] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(h.as(1).create({ ...base, bindings: [{ ...base.bindings[0]!, mcpTool: "restart_service" }] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(h.store.rows.size).toBe(0);
  });

  it("enforces workspace membership and tenant scoping on every procedure", async () => {
    const h = harness();
    const { investigationId } = await h.as(1).create(base);
    const outsider = h.as(3);                                    // member of workspace 8 only
    await expect(outsider.get({ workspaceId: WS, investigationId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(outsider.list({ workspaceId: WS })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(outsider.cancel({ workspaceId: WS, investigationId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(outsider.export({ workspaceId: WS, investigationId, format: "json" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    // member of both workspaces, wrong workspace id: indistinguishable from "does not exist"
    const both = harness({ members: { 1: [WS, 8] } }); const mine = await both.as(1).create(base);
    await expect(both.as(1).get({ workspaceId: 8, investigationId: mine.investigationId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await both.as(1).list({ workspaceId: 8 })).items).toEqual([]);
  });

  it("a queued investigation shows empty evidence/tool/final data - nothing fabricated", async () => {
    const h = harness();
    const { investigationId } = await h.as(1).create(base);
    const v = await h.as(1).get({ workspaceId: WS, investigationId });
    expect(v.investigation.status).toBe("QUEUED");
    expect(v.toolCalls).toEqual([]); expect(v.evidence).toEqual([]); expect(v.timeline).toEqual([]); expect(v.decisions).toEqual([]);
    expect(v.final).toBeNull(); expect(v.verification).toBeNull(); expect(v.hypotheses.latest).toEqual([]);
    expect(v.progress).toMatchObject({ phase: "queued", percent: 0 });
  });

  it("cancel: a queued investigation is cancelled at once; a running one only records the request; strangers cannot cancel", async () => {
    const h = harness();
    const { investigationId, taskId } = await h.as(1).create(base);
    await expect(h.as(2).cancel({ workspaceId: WS, investigationId })).rejects.toMatchObject({ code: "FORBIDDEN" });   // member but neither creator nor owner
    expect(await h.as(1).cancel({ workspaceId: WS, investigationId })).toMatchObject({ status: "CANCELLED", cancelRequested: true });
    expect((await h.store.get(WS, investigationId))!.status).toBe("CANCELLED");
    expect(h.tasks.tasks.get(taskId!)!.state).toBe("CANCELLED");
    expect(await h.as(1).cancel({ workspaceId: WS, investigationId })).toMatchObject({ status: "CANCELLED", cancelRequested: false });

    const r = await h.as(1).create({ ...base, title: "second incident" });
    h.tasks.tasks.get(r.taskId!)!.state = "RUNNING"; await h.store.markRunning(WS, r.investigationId);
    expect(await h.as(1).cancel({ workspaceId: WS, investigationId: r.investigationId })).toMatchObject({ status: "RUNNING", cancelRequested: true });
    expect(h.tasks.tasks.get(r.taskId!)!.cancelRequested).toBe(true);
    // a workspace owner who is not the creator may cancel
    const o = harness({ members: { 1: [WS], 2: [WS] }, owners: { 2: [WS] } }); const c = await o.as(1).create(base);
    expect(await o.as(2).cancel({ workspaceId: WS, investigationId: c.investigationId })).toMatchObject({ cancelRequested: true });
  });

  it("after a real handler run the API exposes evidence, citations, hypotheses, proposed remediation, integrity and exports", async () => {
    const h = harness();
    const { investigationId } = await h.as(1).create({ ...base, bindings: base.bindings });
    // run the actual handler against the same store (the id comes from the router, so use a ctx bound to it)
    const row = (await h.store.get(WS, investigationId))!;
    const { ctx } = fakeCtx({ input: { investigationId }, task: { id: row.taskId! } });
    await createSentinelInvestigateHandler({ store: h.store, mcp: { callTool: async () => { throw new Error("unused"); } }, enabled: () => true, config: () => ({ policyTimeoutMs: 5000, toolAttemptTimeoutMs: 2000, maxModelCalls: 24, formatRetries: 1, cancelPollMs: 20 }),
      transportFor: () => new FakeTools(), modelFor: () => goodModel() })(ctx);

    const v = await h.as(1).get({ workspaceId: WS, investigationId });
    expect(v.investigation.status).toBe("COMPLETED");
    expect(v.toolCalls.map((t) => [t.tool, t.status])).toEqual([["logs.search", "OK"], ["metrics.query", "OK"]]);
    expect(v.evidence.length).toBe(2); expect(v.evidence.every((e) => e.cited)).toBe(true);
    expect(v.final?.outcome).toBe("DIAGNOSIS"); expect(v.final?.citations.length).toBe(2);
    expect(v.final?.remediation).toMatchObject({ executed: false, requiresApproval: true, status: "PROPOSED_NOT_EXECUTED" });
    expect(v.hypotheses.latest[0]).toMatchObject({ label: "DISK_FULL" }); expect(v.hypotheses.history.length).toBeGreaterThanOrEqual(3);
    expect(v.verification).toMatchObject({ passed: true, mode: "structural" });
    expect(v.integrity).toMatchObject({ chainOk: true, complete: true });
    expect(v.progress).toMatchObject({ phase: "finished", percent: 100 });
    const p = await h.as(1).progress({ workspaceId: WS, investigationId });
    expect(p).toMatchObject({ status: "COMPLETED", terminal: true, eventCount: v.integrity.eventCount });

    const md = await h.as(1).export({ workspaceId: WS, investigationId, format: "markdown" });
    expect(md.mimeType).toBe("text/markdown"); expect(md.content).toContain("Diagnosis: DISK_FULL"); expect(md.content).toContain("NOT executed"); expect(md.content).toContain("no space left on device");
    expect(md.content).toContain("read-only");
    const js = JSON.parse((await h.as(1).export({ workspaceId: WS, investigationId, format: "json" })).content);
    expect(js).toMatchObject({ schema: "sakthiai.sentinel.report/2", state: "COMPLETE", remediation: { executed: false, status: "PROPOSED_NOT_EXECUTED" } });
    expect(js.citations.length).toBe(2);
    const audit = await h.as(1).audit({ workspaceId: WS, investigationId });
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(["CREATE", "EXPORT_REPORT"]));
  });

  it("markdown export cannot be broken out of by hostile evidence text", async () => {
    const h = harness();
    const { investigationId } = await h.as(1).create(base);
    const row = (await h.store.get(WS, investigationId))!;
    const hostile = "```\n# INJECTED HEADING\n```\n[click](http://evil.example)";
    const { ctx } = fakeCtx({ input: { investigationId }, task: { id: row.taskId! } });
    await createSentinelInvestigateHandler({ store: h.store, mcp: { callTool: async () => { throw new Error("unused"); } }, enabled: () => true, config: () => ({ policyTimeoutMs: 5000, toolAttemptTimeoutMs: 2000, maxModelCalls: 24, formatRetries: 1, cancelPollMs: 20 }),
      transportFor: () => new FakeTools((tool) => (tool === "metrics.query" ? ["WARN data volume usage 100 percent"] : [hostile])), modelFor: () => goodModel() })(ctx);
    const md = (await h.as(1).export({ workspaceId: WS, investigationId, format: "markdown" })).content;
    const lines = md.split("\n");
    expect(lines.filter((l) => l.trim() === "# INJECTED HEADING").length).toBeLessThanOrEqual(1);
    // every occurrence of the hostile heading sits inside a fence longer than the backtick run in the payload
    const idx = lines.findIndex((l) => l.trim() === "# INJECTED HEADING");
    if (idx >= 0) { const outer = [...lines.slice(0, idx)].reverse().find((l) => /^`{4,}$/.test(l.trim())); const closer = lines.slice(idx).find((l) => /^`{4,}$/.test(l.trim())); expect(outer).toBeDefined(); expect(closer).toBe(outer); }
  });
});

describe("sentinel router: lifecycle gaps", () => {
  const start = async (h: ReturnType<typeof harness>) => (await h.as(1).create({ ...base, idempotencyKey: "key-lifecycle-1" }));

  it("reconciles an investigation whose durable task failed before the handler could finalise it (never to a success state)", async () => {
    const h = harness(); const { investigationId, taskId } = await start(h);
    expect((await h.as(1).progress({ workspaceId: WS, investigationId })).status).toBe("QUEUED");
    const t = h.tasks.tasks.get(taskId!)!; t.state = "FAILED"; t.failureClass = "PROVIDER_UNAVAILABLE";
    const p = await h.as(1).progress({ workspaceId: WS, investigationId });
    expect(p).toMatchObject({ status: "FAILED", terminal: true });
    const row = (await h.store.get(WS, investigationId))!;
    expect(row).toMatchObject({ status: "FAILED", stopReason: "TASK_PROVIDER_UNAVAILABLE", verified: false, outcome: null, label: null });
    expect(row.errorMessage).toMatch(/provider was unavailable/);
    // a task cancelled by the worker side is reflected as CANCELLED
    const h2 = harness(); const b = await start(h2); h2.tasks.tasks.get(b.taskId!)!.state = "CANCELLED";
    expect((await h2.as(1).get({ workspaceId: WS, investigationId: b.investigationId })).investigation.status).toBe("CANCELLED");
  });

  it("does not overwrite a row the handler already finished, and keeps a running task running", async () => {
    const h = harness(); const { investigationId, taskId } = await start(h);
    const task = h.tasks.tasks.get(taskId!)!; task.state = "RUNNING";
    expect((await h.as(1).progress({ workspaceId: WS, investigationId })).status).toBe("QUEUED");
    const { ctx } = fakeCtx({ task: { id: taskId!, workspaceId: WS }, input: { investigationId } });
    await createSentinelInvestigateHandler({ store: h.store, mcp: { callTool: async () => { throw new Error("unused"); } }, enabled: () => true, config: () => ({ policyTimeoutMs: 5000, toolAttemptTimeoutMs: 2000, maxModelCalls: 24, formatRetries: 1, cancelPollMs: 20 }),
      transportFor: () => new FakeTools(), modelFor: () => goodModel() })(ctx);
    task.state = "FAILED"; task.failureClass = "INTERNAL";             // a later failure signal must not rewrite a completed investigation
    expect((await h.as(1).progress({ workspaceId: WS, investigationId })).status).toBe("COMPLETED");
  });

  it("pages the history with a cursor and rejects a forged cursor", async () => {
    const h = harness();
    for (let i = 0; i < 3; i++) await h.as(1).create({ ...base, title: `Incident number ${i}`, idempotencyKey: `key-page-${i}-xx` });
    const p1 = await h.as(1).list({ workspaceId: WS, limit: 2 });
    expect(p1.items).toHaveLength(2); expect(p1.nextCursor).not.toBeNull();
    const p2 = await h.as(1).list({ workspaceId: WS, limit: 2, cursor: p1.nextCursor! });
    expect(p2.items).toHaveLength(1); expect(p2.nextCursor).toBeNull();
    expect(new Set([...p1.items, ...p2.items].map((r) => r.id)).size).toBe(3);
    await expect(h.as(1).list({ workspaceId: WS, cursor: "AAAA" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("deletes only finished investigations, only for the creator or an owner, and keeps the audit trail", async () => {
    const h = harness(); const { investigationId } = await start(h);
    await expect(h.as(1).delete({ workspaceId: WS, investigationId })).rejects.toMatchObject({ code: "CONFLICT" });   // still queued
    await h.as(1).cancel({ workspaceId: WS, investigationId });
    await expect(h.as(2).delete({ workspaceId: WS, investigationId })).rejects.toMatchObject({ code: "FORBIDDEN" });  // member, not creator/owner
    await expect(h.as(3).delete({ workspaceId: WS, investigationId })).rejects.toMatchObject({ code: "FORBIDDEN" });  // other workspace
    expect(await h.as(1).delete({ workspaceId: WS, investigationId })).toEqual({ deleted: true });
    await expect(h.as(1).get({ workspaceId: WS, investigationId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(h.store.audit.map((a) => a.action)).toEqual(expect.arrayContaining(["CREATE", "CANCEL_REQUESTED", "DELETE"]));
  });

  it("describes connectors honestly: synthetic vs remote, operator config only for owners, never a secret value", async () => {
    const env = { MCP_ALLOWED_ENDPOINTS: "http://127.0.0.1:9100,https://monitoring.example.com", MCP_ALLOW_LOOPBACK_HTTP: "true", MCP_SECRET_PROM_TOKEN: "super-secret-value-123", MCP_SECRET_EMPTY: "", OTHER: "x" };
    const owner = harness();
    const mk = (userId: number) => {
      const api = router({ sentinel: createSentinelRouter({ store: () => owner.store, tasks: () => owner.tasks as never, mcp: () => catalogFor(WS), enabled: () => true, workerEnabled: () => true, env: () => env,
        requireWorkspace: async (u, w) => { if (![1, 2].includes(u) || w !== WS) throw new TRPCError({ code: "FORBIDDEN" }); return {}; }, isWorkspaceOwner: async (u) => u === 1 }) });
      return api.createCaller({ req: {} as TrpcContext["req"], res: { headersSent: false, setHeader: vi.fn() } as unknown as TrpcContext["res"], requestId: "t", user: { id: userId, openId: `u${userId}`, name: "U", email: null, loginMethod: "oidc", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() } }).sentinel;
    };
    const o = await mk(1).connectorCatalog({ workspaceId: WS });
    expect(o.canManage).toBe(true);
    expect(o.connectors.map((c) => [c.name, c.locality, c.synthetic])).toEqual([["synthetic-diag", "local", true], ["prod-monitoring", "remote", false]]);
    expect(o.connectors.every((c) => /not (a production monitoring system|verified as production monitoring)/.test(c.localityLabel))).toBe(true);
    expect(o.config).toMatchObject({ loopbackHttpAllowed: true, privateNetworkAllowed: false, secretRefs: ["PROM_TOKEN"] });
    expect(JSON.stringify(o)).not.toContain("super-secret-value-123");
    const m = await mk(2).connectorCatalog({ workspaceId: WS });
    expect(m.canManage).toBe(false); expect(m.config).toBeNull();
    await expect(mk(3).connectorCatalog({ workspaceId: WS })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("sentinel report v2 and model readiness", () => {
  const run = async (h: ReturnType<typeof harness>, text?: (tool: string) => string[]) => {
    const { investigationId } = await h.as(1).create({ ...base, title: "Écrire <b>fail</b> / ..\\evil: orders-db!!" });
    const row = (await h.store.get(WS, investigationId))!;
    const { ctx } = fakeCtx({ input: { investigationId }, task: { id: row.taskId! } });
    await createSentinelInvestigateHandler({ store: h.store, mcp: { callTool: async () => { throw new Error("unused"); } }, enabled: () => true, config: () => ({ policyTimeoutMs: 5000, toolAttemptTimeoutMs: 2000, maxModelCalls: 24, formatRetries: 1, cancelPollMs: 20 }),
      transportFor: () => new FakeTools(text), modelFor: () => goodModel() })(ctx);
    return investigationId;
  };

  it("report carries timestamps, runtime identity limits, hypothesis history, per-record provenance, audit and approval status", async () => {
    const h = harness(); const investigationId = await run(h);
    await h.as(1).cancel({ workspaceId: WS, investigationId });                       // no-op on a finished run, must not be audited as a cancel of a live one
    const js = JSON.parse((await h.as(1).export({ workspaceId: WS, investigationId, format: "json" })).content);
    expect(js.timestamps).toMatchObject({ createdAt: expect.any(String), finishedAt: expect.any(String) });
    expect(js.runtime).toMatchObject({ providerIdentityCaptured: false, modelCalls: expect.any(Number) });
    expect(js.runtime.note).toMatch(/UNVERIFIED/); expect(js.runtime.modelIdentity.status).toBe("UNVERIFIED");
    expect(js.hypothesisHistory.length).toBeGreaterThanOrEqual(3);
    expect(js.citations.every((c: { source: string | null }) => c.source === "fake")).toBe(true);
    expect(js.toolActivity.map((t: { source: string }) => t.source)).toEqual(["fake", "fake"]);
    expect(js.remediation).toMatchObject({ executed: false, approval: "NONE_RECORDED" });
    expect(js.audit.map((a: { action: string }) => a.action)).toContain("CREATE");
  });

  it("export filenames are safe and the printable HTML escapes hostile evidence and forbids script/network via CSP", async () => {
    const h = harness();
    const hostile = `<script>alert(1)</script><img src=x onerror=alert(2)> & "q"`;
    const investigationId = await run(h, (tool) => (tool === "metrics.query" ? ["WARN data volume usage 100 percent"] : [hostile]));
    for (const format of ["json", "markdown", "html"] as const) {
      const r = await h.as(1).export({ workspaceId: WS, investigationId, format });
      expect(r.filename).toMatch(/^sentinel-[a-z0-9-]{0,41}[a-f0-9]{8}\.(json|md|html)$/);
      expect(r.filename).not.toMatch(/[\\/:<>"|?*\s]|\.\./);
    }
    const html = (await h.as(1).export({ workspaceId: WS, investigationId, format: "html" })).content;
    expect(html).toContain("Content-Security-Policy"); expect(html).toContain("default-src 'none'");
    expect(html).not.toContain("<script"); expect(html).not.toMatch(/<img[^>]*onerror/i); expect(html).not.toContain("<b>fail</b>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("NOT executed");
  });

  it("publishes honest model readiness and refuses to start when no provider can run", async () => {
    const mk = (state: string) => {
      const h = harness(); const api = router({ sentinel: createSentinelRouter({ store: () => h.store, tasks: () => h.tasks as never, mcp: () => catalogFor(WS), enabled: () => true, workerEnabled: () => true,
        modelReadiness: () => ({ state, configuredProviders: state === "no_provider_configured" ? 0 : 1, eligibleProviders: state === "eligible" ? 1 : 0, operational: "unverified" }),
        requireWorkspace: async () => ({}), isWorkspaceOwner: async () => true }) });
      return api.createCaller({ req: {} as TrpcContext["req"], res: { headersSent: false, setHeader: vi.fn() } as unknown as TrpcContext["res"], requestId: "t", user: { id: 1, openId: "u1", name: "U", email: null, loginMethod: "oidc", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() } }).sentinel;
    };
    expect((await mk("no_provider_configured").status({ workspaceId: WS })).model).toMatchObject({ state: "no_provider_configured", operational: "unverified" });
    await expect(mk("no_provider_configured").create(base)).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringMatching(/No model provider/) });
    await expect(mk("not_permitted_by_policy").create(base)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(mk("eligible").create(base)).resolves.toMatchObject({ created: true });
  });
});
