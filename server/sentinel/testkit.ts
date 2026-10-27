import { MockModelTransport } from "./engine/model_transport";
import type { BackendOutcome, ToolTransport } from "./engine/transport";
import type { TaskContext } from "../tasks/worker";
import { TaskCancelledError, TaskLeaseLostError } from "../tasks/types";
import type { TaskRecord } from "../tasks/types";
import type { InvestigationRecord } from "./types";
import { LIMIT_DEFAULTS } from "./config";

/** Shared fixtures for Sentinel tests (kept out of *.test.ts so tsc checks them and several test files can import them). */
export const WS = 7, OTHER_WS = 8, USER = 3;
export const ID = "11111111-1111-4111-8111-111111111111";

export const newRow = (over: Partial<InvestigationRecord> = {}) => ({
  id: ID, workspaceId: WS, createdByUserId: USER, title: "Disk alarm on db-1", severity: "high" as const, service: "orders-db", firedAt: "2026-10-01T10:00:00Z",
  description: "Writes failing on orders-db", objective: "Find the root cause of the write failures", operatorNotes: [], inventory: { services: ["orders-db"], hosts: ["db-1"] },
  allowedTools: ["metrics.query", "logs.search", "config.get"] as InvestigationRecord["allowedTools"], limits: { ...LIMIT_DEFAULTS }, bindings: [], ...over,
});

export const task = (over: Partial<TaskRecord> = {}): TaskRecord => ({
  id: "22222222-2222-4222-8222-222222222222", workspaceId: WS, createdByUserId: USER, type: "sentinel.investigate", state: "RUNNING", idempotencyKey: null, input: { investigationId: ID }, checkpoint: null, checkpointSeq: 0,
  progressPercent: null, progressNote: null, result: null, attempt: 1, maxAttempts: 3, retryAfter: null, leaseOwner: "w", leaseExpiresAt: null, cancelRequested: false, failureClass: null, errorMessage: null,
  createdAt: new Date(), updatedAt: new Date(), startedAt: null, finishedAt: null, ...over,
});

export function fakeCtx(over: { task?: Partial<TaskRecord>; input?: unknown; attempt?: number; onCheckpoint?: (n: number) => void } = {}) {
  const state = { cancelled: false, lost: false, checkpoints: 0 };
  const t = task({ ...(over.task ?? {}), ...(over.input !== undefined ? { input: over.input } : {}), ...(over.attempt ? { attempt: over.attempt } : {}) });
  const ctx: TaskContext = {
    task: t, input: t.input, checkpoint: null, attempt: t.attempt,
    saveCheckpoint: async () => { if (state.lost) throw new TaskLeaseLostError(); state.checkpoints++; over.onCheckpoint?.(state.checkpoints); if (state.cancelled) throw new TaskCancelledError(); },
    throwIfCancelled: () => { if (state.lost) throw new TaskLeaseLostError(); if (state.cancelled) throw new TaskCancelledError(); },
    effect: async (_k, run) => run(),
    invokeModel: async () => { throw new Error("invokeModel must not be called in this test"); },
    invokeModelDetailed: async () => { throw new Error("invokeModelDetailed must not be called in this test"); },
  };
  return { ctx, state };
}

/** Deterministic fake diagnostic backend for the test only. */
export class FakeTools implements ToolTransport {
  calls: Array<{ tenant: string; tool: string; target: string }> = [];
  n = 0;
  constructor(private readonly text: (tool: string, target: string) => string[] = (tool) => (tool === "metrics.query" ? ["WARN data volume usage 100 percent"] : ["ERROR no space left on device while writing"]),
    private readonly outcome?: (n: number) => BackendOutcome | null) {}
  async exec(tenant: string, tool: string, target: string): Promise<BackendOutcome> {
    this.calls.push({ tenant, tool, target });
    const forced = this.outcome?.(this.calls.length); if (forced) return forced;
    const id = `o${++this.n}`;
    return { kind: "ok", virtual_ms: 5, obs: [{ obs_id: id, tool, target, tenant, source_system: "fake", records: this.text(tool, target).map((text, i) => ({ ts: `2026-10-01T09:5${i}:00Z`, level: "ERROR", text })) }] };
  }
}

export const ridsIn = (user: string): string[] => { const h = (JSON.parse(user) as { history: Array<{ records: Array<{ rid: string }> }> }).history; return h.flatMap((x) => x.records.map((r) => r.rid)); };
export const hyp = (supporting: string[], score = 0.7) => [{ label: "DISK_FULL", score, status: "LEADING", supporting }];

/** Scripted model: logs.search, then metrics.query, then a FINAL diagnosis citing both. */
export const goodModel = () => new MockModelTransport((req) => {
  const rids = ridsIn(req.user);
  if (rids.length === 0) return JSON.stringify({ type: "CALL", tool: "logs.search", target: "orders-db", rationale: "Look for write errors first", hypotheses: hyp([], 0.4) });
  if (rids.length === 1) return JSON.stringify({ type: "CALL", tool: "metrics.query", target: "db-1", rationale: "Check volume usage", hypotheses: hyp([rids[0]!], 0.6) });
  return JSON.stringify({ type: "FINAL", outcome: "DIAGNOSIS", label: "DISK_FULL", summary: "Writes fail with no space left and the data volume is at 100 percent.", cited: [rids[0], rids[1]],
    contradictions: [], confidence: 0.85, remediation_proposal: "Free space on the data volume under change control, then re-check write errors.", next_safe_steps: ["Confirm volume usage on db-1"], hypotheses: hyp([rids[0]!, rids[1]!], 0.9) });
});

