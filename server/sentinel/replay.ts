import type { Checkpoint } from "./engine/checkpoint";
import type { TraceEvent } from "./engine/trace";
import type { FinalAnswer, Hypothesis, ToolRequest, ToolResult } from "./engine/types";
import type { InvestigationStatus, StoredEvent } from "./types";

/**
 * The durable record of an investigation is its hash-chained event list (sentinelEvents). Everything else - the engine checkpoint used to
 * resume after a crash, the final summary stored on the row, the API views and the report - is DERIVED from those events. There is
 * therefore one source of truth, and a resume re-validates the chain, the tool results and the broker state before continuing.
 */

const asTrace = (events: StoredEvent[]): TraceEvent[] => events.map((e) => ({ seq: e.seq, type: e.type, vt: e.vt, payload: e.payload, prev: e.prev, hash: e.hash }));

/** Rebuild a ToolResult from its tool_result trace event (seq is the result's index; the stored result_hash is re-verified by Broker.restore). */
export function toolResultFromEvent(e: { payload: unknown }, index: number): ToolResult {
  const p = e.payload as Omit<ToolResult, "seq">;
  const r: ToolResult = {
    seq: index, request: p.request, status: p.status, records: p.records, quarantined: p.quarantined, attempts: p.attempts, replayed: p.replayed, virtual_ms: p.virtual_ms, result_hash: p.result_hash,
    ...(p.deny_reason !== undefined && p.deny_reason !== null ? { deny_reason: p.deny_reason } : {}),
    ...(p.error !== undefined && p.error !== null ? { error: p.error } : {}),
    ...(p.source_system !== undefined && p.source_system !== null ? { source_system: p.source_system } : {}),
  };
  return r;
}

export const isFinished = (events: StoredEvent[]): boolean => events.some((e) => e.type === "run_end");

/** Engine checkpoint for Investigation.resume, or null when there is nothing to resume (no events yet). Throws if events already finished. */
export function checkpointFromEvents(caseId: string, events: StoredEvent[]): Checkpoint | null {
  if (!events.length) return null;
  if (isFinished(events)) throw new Error("ALREADY_FINISHED");
  const trace = asTrace(events);
  const start = trace[0]!;
  if (start.type !== "run_start") throw new Error("TRACE_START");
  const sp = start.payload as { policy_id: string; policy_kind: string };
  const results = trace.filter((e) => e.type === "tool_result").map((e, i) => toolResultFromEvent(e, i));
  const decisions = trace.filter((e) => e.type === "decision").map((e) => e.payload as { step: number; hypotheses: Hypothesis[] });
  const last = trace[trace.length - 1]!;
  let phase: Checkpoint["phase"] = "AWAIT_DECISION";
  let pending: Checkpoint["pending"] = null;
  let step = decisions.reduce((m, d) => Math.max(m, d.step), 0);
  if (last.type === "tool_request") {
    const lp = last.payload as { step: number; request: ToolRequest };
    phase = "AWAIT_TOOL"; pending = { step: lp.step, request: lp.request }; step = lp.step;
  }
  return {
    v: 1, case_id: caseId, policy_id: sp.policy_id, policy_kind: sp.policy_kind, step, phase, pending, results, trace, trace_head: last.hash,
    hypothesis_history: decisions.map((d) => ({ step: d.step, hypotheses: d.hypotheses })),
    resumes: trace.filter((e) => e.type === "resumed").length,
  };
}

export interface FinalSummary {
  status: InvestigationStatus; stopReason: string; outcome: "DIAGNOSIS" | "ABSTAIN" | null; label: string | null; confidence: number | null;
  verified: boolean; traceHead: string | null; eventCount: number; errorMessage: string | null;
}

/** Row summary derived from a finished event list. Returns null while the investigation has no run_end event. */
export function summaryFromEvents(events: StoredEvent[]): FinalSummary | null {
  const end = events.find((e) => e.type === "run_end");
  if (!end) return null;
  const fin = events.find((e) => e.type === "final");
  const f = fin?.payload as FinalAnswer | undefined;
  const stop = (end.payload as { stop_reason?: string }).stop_reason ?? "UNKNOWN";
  const pe = events.find((e) => e.type === "policy_error");
  const providerFailure = stop === "POLICY_ERROR" || stop === "POLICY_TIMEOUT";
  const status: InvestigationStatus = stop === "CANCELLED" ? "CANCELLED" : providerFailure ? "FAILED" : f?.outcome === "DIAGNOSIS" ? "COMPLETED" : "ABSTAINED";
  return {
    status, stopReason: stop, outcome: f?.outcome ?? null, label: f?.label ?? null, confidence: typeof f?.confidence === "number" ? f.confidence : null,
    verified: f?.outcome === "DIAGNOSIS" && !events.some((e) => e.type === "verifier_reject"),   // an abstention or a failure has no diagnosis to verify
    traceHead: events[events.length - 1]!.hash, eventCount: events.length,
    errorMessage: providerFailure ? String((pe?.payload as { message?: string } | undefined)?.message ?? stop).slice(0, 200) : null,
  };
}
