import { createHash, randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import type { MysqlTaskStore } from "../tasks/store";
import { SENTINEL_INVESTIGATE_TASK, clampLimits, sentinelEnabled, sentinelMaxActive } from "./config";
import { BindingError, validateBindingsLive } from "./adapters/contract";
import { LOCALITY_LABEL, classifyEndpoint, connectorCatalog } from "./adapters/connectorInfo";
import type { BindingCatalog } from "./adapters/contract";
import type { ConnectorView } from "../connectors/mcp";
import { READ_TOOLS } from "./engine/types";
import { buildReport, renderHtml, renderMarkdown, reportStem } from "./report";
import { SentinelConflictError } from "./store";
import type { SentinelStore } from "./store";
import { INVESTIGATION_STATUSES, SEVERITIES, isTerminalStatus } from "./types";
import type { DiagnosticBinding, InvestigationRecord, ReadTool, StoredEvent } from "./types";
import { buildView, summaryRow } from "./view";

export interface SentinelRouterDeps {
  store: () => SentinelStore;
  tasks: () => Pick<MysqlTaskStore, "create" | "get" | "cancel">;
  /** the existing McpConnectorService (list + discover) */ mcp: () => Omit<BindingCatalog, "list"> & { list(workspaceId: number): Promise<ConnectorView[]> };
  requireWorkspace: (userId: number, workspaceId: number) => Promise<unknown>;
  isWorkspaceOwner: (userId: number, workspaceId: number) => Promise<boolean>;
  /** Sentinel feature flag (default off) */ enabled?: () => boolean;
  /** operator environment (default process.env); only used to describe connector configuration, never returned verbatim */ env?: () => Record<string, string | undefined>;
  /** static gateway readiness (no provider call, no spend); undefined = unknown */ modelReadiness?: () => { state: string; configuredProviders: number; eligibleProviders: number; operational: "verified" | "unverified" } | null;
  /** shared task worker runtime enabled (without it a queued investigation would never run) */ workerEnabled: () => boolean;
  /** most QUEUED+RUNNING investigations per workspace (default SENTINEL_MAX_ACTIVE_PER_WORKSPACE, 5) */ maxActive?: () => number;
}

const NAME = /^[\w.\-:]{1,120}$/;
const bindingSchema = z.object({
  tool: z.enum(READ_TOOLS),
  connectorId: z.string().uuid(),
  mcpTool: z.string().min(1).max(128),
  targetParam: z.string().min(1).max(64),
  queryParam: z.string().min(1).max(64).optional(),
  windowParam: z.string().min(1).max(64).optional(),
  fixedArgs: z.record(z.string().max(64), z.union([z.string().max(200), z.number(), z.boolean()])).optional().refine((v) => !v || Object.keys(v).length <= 10, "too many fixed arguments"),
}).strict();

const workspaceInput = z.object({ workspaceId: z.number().int().positive() });
const idInput = workspaceInput.extend({ investigationId: z.string().uuid() });

export const createInput = workspaceInput.extend({
  title: z.string().trim().min(3).max(200),
  severity: z.enum(SEVERITIES).default("medium"),
  service: z.string().regex(NAME, "service must be a name of letters, digits and . _ - :"),
  firedAt: z.string().datetime({ offset: true }).optional(),
  description: z.string().trim().min(5).max(4000),
  objective: z.string().trim().min(5).max(500).optional(),
  operatorNotes: z.array(z.string().trim().min(1).max(500)).max(10).default([]),
  hosts: z.array(z.string().regex(NAME)).max(20).default([]),
  relatedServices: z.array(z.string().regex(NAME)).max(20).default([]),
  bindings: z.array(bindingSchema).min(1).max(READ_TOOLS.length),
  limits: z.object({ max_tool_calls: z.number().int(), max_steps: z.number().int(), max_retries_per_call: z.number().int(), max_virtual_ms: z.number().int() }).partial().optional(),
  idempotencyKey: z.string().min(8).max(128).optional(),
});

/** Deterministic id from a client idempotency key (scoped to workspace+user), so a retried create returns the same investigation. */
const idFromKey = (workspaceId: number, userId: number, key: string): string => {
  const h = createHash("sha256").update(`sentinel:${workspaceId}:${userId}:${key}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

/** A row with no task younger than this may still be mid-creation; older is an orphan. */
const ORPHAN_GRACE_MS = 5 * 60_000;

export function createSentinelRouter(deps: SentinelRouterDeps) {
  const enabled = () => (deps.enabled ?? (() => sentinelEnabled()))();
  const requireEnabled = () => {
    if (!enabled()) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Sentinel is not enabled on this deployment" });
    if (!deps.workerEnabled()) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The background task worker is not enabled, so investigations cannot run" });
    const m = modelState();
    if (m && (m.state === "no_provider_configured" || m.state === "not_permitted_by_policy")) throw new TRPCError({ code: "PRECONDITION_FAILED", message: m.state === "no_provider_configured" ? "No model provider is configured for this deployment, so investigations cannot run" : "Model policy does not permit any configured provider, so investigations cannot run" });
  };
  const modelState = () => { try { return deps.modelReadiness?.() ?? null; } catch { return null; } };
  const load = async (userId: number, workspaceId: number, investigationId: string): Promise<InvestigationRecord> => {
    await deps.requireWorkspace(userId, workspaceId);
    const row = await deps.store().get(workspaceId, investigationId);
    if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Investigation not found" });
    return row;
  };
  /** Queue (idempotently, keyed by the investigation id) and attach the durable task. Safe to call again for a row that has no task yet. */
  const enqueue = async (workspaceId: number, userId: number, investigationId: string): Promise<string> => {
    const { task } = await deps.tasks().create({ workspaceId, type: SENTINEL_INVESTIGATE_TASK, input: { investigationId }, idempotencyKey: `sentinel:${investigationId}`, maxAttempts: 3, createdByUserId: userId });
    await deps.store().attachTask(workspaceId, investigationId, task.id);
    return task.id;
  };
  /**
   * Row and events read as one consistent pair. The store updates the row's eventCount in the same transaction that appends events, so a
   * mismatch means a writer slipped in between the two reads; retry a few times (a live run may legitimately keep moving, so the last read wins).
   */
  const snapshot = async (userId: number, workspaceId: number, investigationId: string): Promise<{ row: InvestigationRecord; events: StoredEvent[] }> => {
    let row = await reconcile(await load(userId, workspaceId, investigationId));
    let events: StoredEvent[] = [];
    for (let i = 0; i < 3; i++) {
      events = await deps.store().readEvents(workspaceId, investigationId);
      const fresh = await deps.store().get(workspaceId, investigationId);
      if (!fresh) throw new TRPCError({ code: "NOT_FOUND", message: "Investigation not found" });
      row = fresh;
      if (fresh.eventCount === events.length) break;
    }
    return { row: await reconcile(row), events };
  };
  /**
   * QUEUED + RUNNING investigations in the workspace after reconciling them against their durable tasks, so a row whose task already died does not
   * hold a slot forever. Reads at most `cap + 1` per status; the first 20 are reconciled, the rest are counted as active.
   */
  const activeCount = async (workspaceId: number, cap: number): Promise<number> => {
    const store = deps.store();
    const rows = [...(await store.listPage(workspaceId, { status: "QUEUED", limit: cap + 1 })).items, ...(await store.listPage(workspaceId, { status: "RUNNING", limit: cap + 1 })).items];
    const head = await Promise.all(rows.slice(0, 20).map((r) => reconcile(r)));
    return head.filter((r) => !isTerminalStatus(r.status)).length + Math.max(0, rows.length - 20);
  };
  const taskInfo = async (row: InvestigationRecord) => {
    if (!row.taskId) return null;
    try {
      const t = await deps.tasks().get(row.workspaceId, row.taskId);
      return t ? { state: t.state, attempt: t.attempt, maxAttempts: t.maxAttempts, cancelRequested: t.cancelRequested, failureClass: t.failureClass, progressNote: t.progressNote } : null;
    } catch { return null; }
  };

  const FAILURE_TEXT: Record<string, string> = {
    PROVIDER_UNAVAILABLE: "The model provider was unavailable and retries were exhausted.", BUDGET_DENIED: "The workspace model budget was exhausted.",
    POLICY_DENIED: "The investigation was blocked by policy.", LEASE_EXPIRED: "The worker stopped responding and retries were exhausted.",
    NON_RETRYABLE: "The investigation could not be executed.", RETRYABLE: "Retries were exhausted.", INTERNAL: "An internal error stopped the investigation.",
  };
  /**
   * The durable task is the execution authority. If the worker ended it (FAILED / CANCELLED) without the handler reaching its own finalise step
   * (e.g. a fatal error before the first event, or a lease lost for good), the row would stay QUEUED/RUNNING forever. Reconcile it truthfully:
   * never to a success state, and never overwriting a row that reached a terminal state itself (finalize is a no-op on terminal rows).
   */
  const reconcile = async (row: InvestigationRecord): Promise<InvestigationRecord> => {
    if (isTerminalStatus(row.status)) return row;
    if (!row.taskId) {
      // Created but never enqueued (the process died between the two writes and no retry came back): after a grace period, fail it truthfully
      // instead of leaving a QUEUED investigation that can never run.
      if (row.status !== "QUEUED" || Date.now() - row.createdAt.getTime() < ORPHAN_GRACE_MS) return row;
      try {
        await deps.store().finalize(row.workspaceId, row.id, { status: "FAILED", stopReason: "ENQUEUE_INCOMPLETE", outcome: null, label: null, confidence: null, verified: false, traceHead: null, eventCount: 0, errorMessage: "The investigation was created but never queued for execution." });
        return (await deps.store().get(row.workspaceId, row.id)) ?? row;
      } catch { return row; }
    }
    try {
      const t = await deps.tasks().get(row.workspaceId, row.taskId);
      if (!t) return row;
      const store = deps.store();
      if (t.state === "CANCELLED") await store.markCancelled(row.workspaceId, row.id);
      else if (t.state === "FAILED") {
        await store.finalize(row.workspaceId, row.id, { status: "FAILED", stopReason: `TASK_${t.failureClass ?? "FAILED"}`, outcome: null, label: null, confidence: null, verified: false, traceHead: row.traceHead, eventCount: row.eventCount, errorMessage: FAILURE_TEXT[t.failureClass ?? ""] ?? "The investigation task failed." });
      } else return row;
      return (await store.get(row.workspaceId, row.id)) ?? row;
    } catch (e) { if (e instanceof SentinelConflictError) return row; return row; }   // a racing writer/handler wins; the next poll sees its result
  };

  return router({
    /** Feature availability. Read-only, no side effects; lets the UI show an honest disabled state. */
    status: protectedProcedure.input(workspaceInput).query(async ({ ctx, input }) => {
      await deps.requireWorkspace(ctx.user.id, input.workspaceId);
      // viewer lets the UI disable actions the server would refuse (cancel/delete are creator-or-owner); the server still enforces them.
      return { enabled: enabled(), workerEnabled: deps.workerEnabled(), readTools: [...READ_TOOLS] as ReadTool[], statuses: [...INVESTIGATION_STATUSES], model: modelState(), viewer: { userId: ctx.user.id, isOwner: await deps.isWorkspaceOwner(ctx.user.id, input.workspaceId) } };
    }),

    create: protectedProcedure.input(createInput).mutation(async ({ ctx, input }) => {
      requireEnabled();
      await deps.requireWorkspace(ctx.user.id, input.workspaceId);
      const bindings = input.bindings as DiagnosticBinding[];
      try { await validateBindingsLive(deps.mcp(), { workspaceId: input.workspaceId, userId: ctx.user.id }, bindings); }
      catch (e) { if (e instanceof BindingError) throw new TRPCError({ code: "BAD_REQUEST", message: e.message }); throw e; }
      const store = deps.store();
      const id = input.idempotencyKey ? idFromKey(input.workspaceId, ctx.user.id, input.idempotencyKey) : randomUUID();
      const existing = input.idempotencyKey ? await store.get(input.workspaceId, id) : null;
      if (existing) {
        // A retry after a crash between "row written" and "task queued" must finish the job, not return a row that can never run.
        if (!existing.taskId && !isTerminalStatus(existing.status)) {
          try { return { investigationId: existing.id, taskId: await enqueue(input.workspaceId, ctx.user.id, existing.id), created: false as const }; }
          catch { throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Could not start the investigation" }); }
        }
        return { investigationId: existing.id, taskId: existing.taskId, created: false as const };
      }
      // Abuse/cost control: a workspace may not queue unbounded investigations (each can make dozens of model calls). An idempotent retry never reaches here.
      const cap = (deps.maxActive ?? (() => sentinelMaxActive()))();
      if ((await activeCount(input.workspaceId, cap)) >= cap) throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: `This workspace already has ${cap} investigations queued or running; wait for one to finish or cancel one` });
      const services = [...new Set([input.service, ...input.relatedServices])];
      await store.create({
        id, workspaceId: input.workspaceId, createdByUserId: ctx.user.id, title: input.title, severity: input.severity, service: input.service,
        firedAt: input.firedAt ?? new Date().toISOString(), description: input.description,
        objective: input.objective ?? `Determine the most likely root cause of: ${input.title}`,
        operatorNotes: input.operatorNotes, inventory: { services, hosts: [...new Set(input.hosts)] }, allowedTools: [...new Set(bindings.map((b) => b.tool))],
        limits: clampLimits(input.limits), bindings,
      });
      await store.recordAudit({ workspaceId: input.workspaceId, investigationId: id, actorUserId: ctx.user.id, action: "CREATE", detail: `tools=${bindings.map((b) => b.tool).join(",")}` });
      try {
        return { investigationId: id, taskId: await enqueue(input.workspaceId, ctx.user.id, id), created: true as const };
      } catch (e) {
        await store.finalize(input.workspaceId, id, { status: "FAILED", stopReason: "ENQUEUE_FAILED", outcome: null, label: null, confidence: null, verified: false, traceHead: null, eventCount: 0, errorMessage: "could not enqueue the investigation task" }).catch(() => undefined);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Could not start the investigation" });
      }
    }),

    /** Keyset-paginated history. Non-terminal rows are reconciled against their durable task (bounded to the first 20 per page). */
    list: protectedProcedure.input(workspaceInput.extend({ limit: z.number().int().min(1).max(200).optional(), status: z.enum(INVESTIGATION_STATUSES).optional(), cursor: z.string().max(200).optional() })).query(async ({ ctx, input }) => {
      await deps.requireWorkspace(ctx.user.id, input.workspaceId);
      let page;
      try { page = await deps.store().listPage(input.workspaceId, { ...(input.limit ? { limit: input.limit } : {}), ...(input.status ? { status: input.status } : {}), ...(input.cursor ? { cursor: input.cursor } : {}) }); }
      catch (e) { if (e instanceof SentinelConflictError) throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid page cursor" }); throw e; }
      let budget = 20;
      const items = await Promise.all(page.items.map(async (r) => (!isTerminalStatus(r.status) && budget-- > 0 ? reconcile(r) : r)));
      return { items: items.map(summaryRow), nextCursor: page.nextCursor };
    }),

    /** Cheap poll target: the UI refetches `get` only when eventCount/status changes. */
    progress: protectedProcedure.input(idInput).query(async ({ ctx, input }) => {
      const row = await reconcile(await load(ctx.user.id, input.workspaceId, input.investigationId));
      return { status: row.status, eventCount: row.eventCount, traceHead: row.traceHead, updatedAt: row.updatedAt.toISOString(), terminal: isTerminalStatus(row.status), task: await taskInfo(row) };
    }),

    get: protectedProcedure.input(idInput).query(async ({ ctx, input }) => {
      const { row, events } = await snapshot(ctx.user.id, input.workspaceId, input.investigationId);
      return { ...buildView(row, events), task: await taskInfo(row) };
    }),

    audit: protectedProcedure.input(idInput).query(async ({ ctx, input }) => {
      await load(ctx.user.id, input.workspaceId, input.investigationId);
      return (await deps.store().listAudit(input.workspaceId, input.investigationId, 50)).map((a) => ({ id: a.id, actorUserId: a.actorUserId, action: a.action, detail: a.detail, createdAt: a.createdAt.toISOString() }));
    }),

    cancel: protectedProcedure.input(idInput).mutation(async ({ ctx, input }) => {
      const row = await load(ctx.user.id, input.workspaceId, input.investigationId);
      if (isTerminalStatus(row.status)) return { status: row.status, cancelRequested: false };
      if (row.createdByUserId !== ctx.user.id && !(await deps.isWorkspaceOwner(ctx.user.id, input.workspaceId))) throw new TRPCError({ code: "FORBIDDEN", message: "Only the creator or a workspace owner can cancel an investigation" });
      const store = deps.store();
      await store.recordAudit({ workspaceId: input.workspaceId, investigationId: input.investigationId, actorUserId: ctx.user.id, action: "CANCEL_REQUESTED" });
      if (!row.taskId) { await store.markCancelled(input.workspaceId, input.investigationId); return { status: "CANCELLED" as const, cancelRequested: true }; }
      let task: Awaited<ReturnType<ReturnType<typeof deps.tasks>["cancel"]>> = null;
      try { task = await deps.tasks().cancel(input.workspaceId, row.taskId); } catch { throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Could not request cancellation" }); }
      // No such task (nothing can be executing) or already cancelled: the investigation is cancelled now.
      if (!task || task.state === "CANCELLED") { await store.markCancelled(input.workspaceId, input.investigationId); return { status: "CANCELLED" as const, cancelRequested: true }; }
      // The task may already have ended another way (FAILED/SUCCEEDED); report what actually happened instead of "cancel requested".
      const after = await reconcile((await store.get(input.workspaceId, input.investigationId)) ?? row);
      if (isTerminalStatus(after.status)) return { status: after.status, cancelRequested: after.status === "CANCELLED" };
      return { status: after.status, cancelRequested: true };   // RUNNING: the worker stops at its next checkpoint and finalises the row
    }),

    /** Delete a finished investigation and its trace (creator or workspace owner). The audit trail is retained. Running investigations must be cancelled first. */
    delete: protectedProcedure.input(idInput).mutation(async ({ ctx, input }) => {
      const row = await reconcile(await load(ctx.user.id, input.workspaceId, input.investigationId));
      if (row.createdByUserId !== ctx.user.id && !(await deps.isWorkspaceOwner(ctx.user.id, input.workspaceId))) throw new TRPCError({ code: "FORBIDDEN", message: "Only the creator or a workspace owner can delete an investigation" });
      if (!isTerminalStatus(row.status)) throw new TRPCError({ code: "CONFLICT", message: "Cancel the investigation and wait for it to stop before deleting it" });
      const store = deps.store();
      const ok = await store.deleteTerminal(input.workspaceId, input.investigationId);
      if (!ok) throw new TRPCError({ code: "NOT_FOUND", message: "Investigation not found" });
      await store.recordAudit({ workspaceId: input.workspaceId, investigationId: input.investigationId, actorUserId: ctx.user.id, action: "DELETE", detail: `status=${row.status}` });
      return { deleted: true as const };
    }),

    /**
     * What a workspace owner needs to manage Sentinel's governed read-only connectors from the UI: the connectors already registered in this
     * workspace (with an honest locality label) and the operator-approved configuration. Management itself goes through the existing
     * connectors.mcp.* procedures (owner-only, SSRF-policed). Never returns secret values or credentials.
     */
    connectorCatalog: protectedProcedure.input(workspaceInput).query(async ({ ctx, input }) => {
      await deps.requireWorkspace(ctx.user.id, input.workspaceId);
      const canManage = await deps.isWorkspaceOwner(ctx.user.id, input.workspaceId);
      const connectors = (await deps.mcp().list(input.workspaceId)).map((c) => {
        const locality = classifyEndpoint(c.endpoint);
        return { id: c.id, name: c.name, endpoint: c.endpoint, enabled: c.enabled, hasSecret: c.hasSecret, allowedTools: c.allowedTools, timeoutMs: c.timeoutMs, maxResponseBytes: c.maxResponseBytes, locality, localityLabel: LOCALITY_LABEL[locality], synthetic: locality === "local" };
      });
      return { canManage, connectors, readTools: [...READ_TOOLS] as ReadTool[], config: canManage ? connectorCatalog(deps.env?.() ?? process.env) : null };
    }),

    export: protectedProcedure.input(idInput.extend({ format: z.enum(["json", "markdown", "html"]) })).mutation(async ({ ctx, input }) => {
      const { row, events } = await snapshot(ctx.user.id, input.workspaceId, input.investigationId);
      const audit = (await deps.store().listAudit(input.workspaceId, input.investigationId, 50)).map((a) => ({ action: a.action, actorUserId: a.actorUserId, detail: a.detail, createdAt: a.createdAt.toISOString() }));
      const report = buildReport(buildView(row, events), new Date(), audit);
      await deps.store().recordAudit({ workspaceId: input.workspaceId, investigationId: input.investigationId, actorUserId: ctx.user.id, action: "EXPORT_REPORT", detail: input.format });
      const stem = reportStem(row.title, row.id);
      if (input.format === "json") return { filename: `${stem}.json`, mimeType: "application/json", content: JSON.stringify(report, null, 2) };
      if (input.format === "html") return { filename: `${stem}.html`, mimeType: "text/html", content: renderHtml(report) };
      return { filename: `${stem}.md`, mimeType: "text/markdown", content: renderMarkdown(report) };
    }),
  });
}
