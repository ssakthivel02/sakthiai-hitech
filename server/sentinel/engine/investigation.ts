import type { CaseDoc, Decision, FinalAnswer, Hypothesis, PolicyView, ToolRequest, ToolResult } from "./types";
import { checkFinalAgainstLedger, isBlocking, reviseLedger } from "./ledger";
import type { RevisionEvent } from "./ledger";
import { Broker } from "./broker";
import type { BrokerStats } from "./broker";
import { TraceBuilder, verifyTrace } from "./trace";
import type { TraceEvent } from "./trace";
import { verifyFinal } from "./verifier";
import type { VerifyOptions, VerifyResult } from "./verifier";
import { hashOf } from "./canon";
import { CheckpointError } from "./checkpoint";
import type { Checkpoint } from "./checkpoint";

export interface CancelToken { cancelled: boolean }
export interface RunResult {
  case_id: string; policy_id: string; policy_kind: string; final: FinalAnswer; verified: boolean; verify: VerifyResult | null;
  trace: TraceEvent[]; trace_head: string; trace_ok: boolean; trace_errors: string[]; stats: BrokerStats; steps: number; stop_reason: string;
  wall_ms: number; virtual_ms: number; denials: Record<string, number>; hypothesis_history: Array<{ step: number; hypotheses: Hypothesis[] }>;
  replayed_from_store: boolean; results: ToolResult[]; resumes: number;
  revisions: RevisionEvent[]; ledger_warnings: string[];
}
export interface InvMeta {
  policy_id: string; policy_kind: string; taxonomy: Record<string, string>; verify?: VerifyOptions; cancel?: CancelToken; note?: string;
  /** a DIAGNOSIS whose hypothesis ledger is inconsistent (unanchored leader flip, invalid refs, label never hypothesised ...) becomes an abstention */ strictLedger?: boolean;
}
export type Action = { kind: "DECIDE"; step: number; force: boolean; view: PolicyView } | { kind: "TOOL"; step: number; request: ToolRequest } | { kind: "DONE" };

export const abstain = (reason: string, summary: string, steps: string[]): FinalAnswer => ({
  outcome: "ABSTAIN", label: "INCONCLUSIVE", summary, cited: [], contradictions: [], confidence: 0,
  remediation: { text: "No remediation proposed.", executed: false, requires_approval: true }, next_safe_steps: steps, abstain_reason: reason,
});
const CANCEL_MSG = "Investigation was cancelled before completion; no conclusion is drawn.";
const CANCEL_STEPS = ["Resume or restart the investigation if still required."];

/**
 * The investigation as an explicit state machine, with no I/O of its own. A synchronous driver (investigate) and an asynchronous
 * driver (investigateAsync) both run it, so the trace, accounting and stop semantics are identical by construction and a
 * checkpoint taken at either driver can be resumed by the other.
 */
export class Investigation {
  readonly c: CaseDoc;
  readonly broker: Broker;
  readonly trace: TraceBuilder;
  hist: ToolResult[] = [];
  hh: RunResult["hypothesis_history"] = [];
  step = 0;
  phase: "AWAIT_DECISION" | "AWAIT_TOOL" = "AWAIT_DECISION";
  pending: { step: number; request: ToolRequest } | null = null;
  resumes = 0;
  revisions: RevisionEvent[] = [];
  ledgerWarnings: string[] = [];
  private seenRids = new Set<string>();
  private lastNew: string[] = [];
  final: FinalAnswer | null = null;
  stop = "";
  private force = false;
  private readonly meta: InvMeta;
  private readonly t0 = performance.now();

  constructor(c: CaseDoc, broker: Broker, meta: InvMeta, trace?: TraceBuilder) {
    this.c = c; this.broker = broker; this.meta = meta; this.trace = trace ?? new TraceBuilder(c.case_id);
  }
  private get vt(): number { return this.broker.stats.virtual_ms; }
  get done(): boolean { return this.final !== null; }

  start(): void {
    this.trace.add("run_start", 0, { case_id: this.c.case_id, policy_id: this.meta.policy_id, policy_kind: this.meta.policy_kind, limits: this.c.limits, objective: this.c.objective,
      allowed_tools: this.c.allowed_tools, writes_enabled: false, note: this.meta.note ?? (this.meta.policy_kind === "deterministic_stub" ? "Rule-based stub policy: decisions are not LLM reasoning." : "LLM policy") });
  }

  private end(final: FinalAnswer, stop: string): void { this.final = final; this.stop = stop; }
  private cancelledEnd(): void { this.end(abstain("CANCELLED", CANCEL_MSG, CANCEL_STEPS), "CANCELLED"); }

  /** Begin the next step: returns the view the policy should decide on, or DONE. */
  nextAction(): Action {
    if (this.final) return { kind: "DONE" };
    if (this.phase === "AWAIT_TOOL" && this.pending) return { kind: "TOOL", step: this.pending.step, request: this.pending.request };
    if (this.step >= this.c.limits.max_steps) return { kind: "DONE" };
    this.step++;
    if (this.meta.cancel?.cancelled) { this.trace.add("cancelled", this.vt, { step: this.step }); this.cancelledEnd(); return { kind: "DONE" }; }
    const b = this.broker;
    this.force = this.step === this.c.limits.max_steps || b.budgetLeft <= 0 || b.timeLeft <= 0;
    return { kind: "DECIDE", step: this.step, force: this.force, view: { case: this.c, history: this.hist.slice(), calls_left: b.budgetLeft, steps_left: this.c.limits.max_steps - this.step, virtual_ms_left: b.timeLeft, force_final: this.force, taxonomy: this.meta.taxonomy } };
  }

  policyFailure(message: string): void {
    this.trace.add("policy_error", this.vt, { step: this.step, message: String(message).slice(0, 200) });
    this.end(abstain("POLICY_ERROR", "The decision policy failed; no conclusion is drawn.", ["Investigate the policy failure and re-run."]), "POLICY_ERROR");
  }

  /** Record the policy's decision. Returns TOOL when a tool call is to be executed, otherwise DONE. */
  applyDecision(d: Decision): Action {
    const okShape = d && typeof d === "object" && (d.type === "FINAL" || (d.type === "CALL" && d.request !== undefined)) && Array.isArray(d.hypotheses);
    if (!okShape) { this.policyFailure("MALFORMED_DECISION"); return { kind: "DONE" }; }
    const step = this.step, force = this.force, b = this.broker;
    this.trace.add("decision", this.vt, { step, type: d.type, ...(d.type === "CALL" ? { request: d.request, rationale: String(d.rationale).slice(0, 300) } : {}), ...(d.model_meta ? { model_meta: d.model_meta } : {}), hypotheses: d.hypotheses });
    this.audit(d.hypotheses);
    this.hh.push({ step, hypotheses: d.hypotheses });
    if (d.type === "FINAL") { this.end(d.final, force ? (b.budgetLeft <= 0 ? "BUDGET_EXHAUSTED" : b.timeLeft <= 0 ? "TIME_EXHAUSTED" : "STEP_LIMIT") : "POLICY_FINAL"); return { kind: "DONE" }; }
    if (force) {
      this.trace.add("call_after_limit_ignored", this.vt, { step, request: d.request });
      this.end(abstain("LIMIT_REACHED_WITH_CALL_PENDING", "Budget or step limit reached while more evidence was still being requested; no conclusion is drawn.", ["Increase the investigation budget under approval, or narrow the target components."]), "LIMIT_REACHED");
      return { kind: "DONE" };
    }
    if (this.cancelBeforeCall()) return { kind: "DONE" };
    this.trace.add("tool_request", this.vt, { step, request: d.request });
    this.phase = "AWAIT_TOOL"; this.pending = { step, request: d.request };
    return { kind: "TOOL", step, request: d.request };
  }

  /** Polled cancellation immediately before a tool call. Returns true (and ends the run) if cancelled. */
  cancelBeforeCall(): boolean {
    if (!this.meta.cancel?.cancelled) return false;
    this.trace.add("cancelled", this.vt, { step: this.step, before_call: true }); this.cancelledEnd(); return true;
  }
  /** Cancellation observed while a policy or tool call was in flight. The in-flight result (if any) is discarded. */
  cancelInFlight(where: "policy" | "tool"): void {
    this.trace.add("cancelled", this.vt, { step: this.step, in_flight: where }); this.cancelledEnd();
    this.phase = "AWAIT_DECISION"; this.pending = null;
  }

  /** Check the policy's reported ledger against the evidence the broker returned; write any revision into the trace. */
  private audit(next: Hypothesis[]): void {
    const ledgers = this.hh.map((x) => x.hypotheses), prev = [...ledgers].reverse().find((l) => l.length > 0) ?? [];
    const rev = reviseLedger({ step: this.step, history: ledgers, prev, next, evidence: this.broker.evidence, newRids: this.lastNew });
    if (!rev) return;
    this.trace.add("hypothesis_revision", this.vt, rev); this.revisions.push(rev); this.ledgerWarnings.push(...rev.warnings);
  }
  private noteRids(res: ToolResult): void {
    this.lastNew = res.records.filter((r) => !r.quarantined && !this.seenRids.has(r.rid)).map((r) => r.rid);
    for (const r of res.records) this.seenRids.add(r.rid);
  }

  recordTool(res: ToolResult): void {
    this.noteRids(res);
    this.hist.push(res);
    this.trace.add("tool_result", this.vt, { step: this.step, request: res.request, status: res.status, deny_reason: res.deny_reason, error: res.error, source_system: res.source_system, records: res.records, quarantined: res.quarantined, attempts: res.attempts, replayed: res.replayed, virtual_ms: res.virtual_ms, result_hash: res.result_hash });
    this.phase = "AWAIT_DECISION"; this.pending = null;
  }

  snapshot(): Checkpoint {
    return structuredClone({ v: 1 as const, case_id: this.c.case_id, policy_id: this.meta.policy_id, policy_kind: this.meta.policy_kind, step: this.step, phase: this.phase, pending: this.pending,
      results: this.broker.results, trace: this.trace.events, trace_head: this.trace.head, hypothesis_history: this.hh, resumes: this.resumes });
  }

  /** Independent verification of whatever the policy produced, then the closing trace events. */
  finish(): RunResult {
    const c = this.c, b = this.broker, trace = this.trace;
    if (!this.final) this.end(abstain("NO_FINAL", "No final answer was produced.", []), "NO_FINAL");
    const fw = checkFinalAgainstLedger(this.final!, this.hh.map((x) => x.hypotheses));
    if (fw.length) { trace.add("ledger_check", this.vt, { warnings: fw }); this.ledgerWarnings.push(...fw); }
    if (this.meta.strictLedger && this.final!.outcome === "DIAGNOSIS") {
      const blocking = this.ledgerWarnings.filter(isBlocking);
      if (blocking.length) {
        trace.add("ledger_reject", this.vt, { rejected_label: this.final!.label, blocking: [...new Set(blocking)].slice(0, 12) });
        this.end(abstain("LEDGER_INCONSISTENT", "The proposed conclusion is not consistent with the hypothesis ledger the investigation reported; no conclusion is drawn.", ["Review the hypothesis revisions in the trace.", "Collect additional independent evidence."]), "LEDGER_REJECTED");
      }
    }
    const final = this.final!;
    const v = verifyFinal(final, c, b.evidence, this.meta.taxonomy, this.meta.verify ?? { requireSignatureSupport: true });
    let out: FinalAnswer = v.sanitized;
    if (!v.ok) {
      trace.add("verifier_reject", this.vt, { fatal: v.fatal, rejected_outcome: final.outcome, rejected_label: final.label });
      out = abstain("VERIFIER_REJECTED", `The proposed conclusion failed independent verification (${v.fatal.map((f) => f.split(":")[0]).filter((x, i, a) => a.indexOf(x) === i).join(", ")}); no conclusion is drawn.`, ["Review the rejected conclusion in the trace.", "Collect additional independent evidence."]);
      this.stop = "VERIFIER_REJECTED";
    } else if (v.redactions.length) trace.add("output_redacted", this.vt, { redactions: v.redactions });
    trace.add("final", this.vt, out);
    trace.add("run_end", this.vt, { stop_reason: this.stop, steps: this.step, stats: b.stats });
    const chk = verifyTrace(trace.events, c.case_id);
    const denials: Record<string, number> = {};
    for (const r of b.results) if (r.status === "DENIED") { const k = (r.deny_reason ?? "?").split(":")[0]!; denials[k] = (denials[k] ?? 0) + 1; }
    return { case_id: c.case_id, policy_id: this.meta.policy_id, policy_kind: this.meta.policy_kind, final: out, verified: v.ok, verify: v, trace: trace.events, trace_head: trace.head, trace_ok: chk.ok, trace_errors: chk.errors,
      stats: { ...b.stats }, steps: this.step, stop_reason: this.stop, wall_ms: Math.round((performance.now() - this.t0) * 1000) / 1000, virtual_ms: b.stats.virtual_ms, denials, hypothesis_history: this.hh, replayed_from_store: false, results: b.results.slice(), resumes: this.resumes, revisions: this.revisions.slice(), ledger_warnings: [...new Set(this.ledgerWarnings)] };
  }

  /**
   * Continue from a checkpoint. The checkpoint is treated as untrusted input: trace chain, trace-vs-results agreement, phase shape and
   * every recorded tool result are re-validated; any inconsistency throws and nothing is resumed. (Authenticity needs openCheckpoint.)
   */
  static resume(c: CaseDoc, broker: Broker, cp: Checkpoint, meta: InvMeta): Investigation {
    const bad = (code: string, d = "") => new CheckpointError(code, d);
    if (!cp || cp.v !== 1) throw bad("VERSION");
    if (cp.case_id !== c.case_id) throw bad("CASE_MISMATCH");
    if (cp.policy_id !== meta.policy_id || cp.policy_kind !== meta.policy_kind) throw bad("POLICY_MISMATCH", `${cp.policy_id} vs ${meta.policy_id}`);
    if (!Number.isInteger(cp.step) || cp.step < 0 || cp.step > c.limits.max_steps) throw bad("STEP_RANGE");
    if (!Array.isArray(cp.results) || !Array.isArray(cp.trace) || !Array.isArray(cp.hypothesis_history)) throw bad("MALFORMED");
    let trace: TraceBuilder;
    try { trace = TraceBuilder.fromEvents(c.case_id, cp.trace); } catch (e) { throw bad("TRACE_CHAIN", (e as Error).message); }
    if (trace.head !== cp.trace_head) throw bad("TRACE_HEAD");
    const ev = cp.trace;
    if (ev.length === 0 || ev[0]!.type !== "run_start") throw bad("TRACE_START");
    if (ev.some((e) => e.type === "final" || e.type === "run_end")) throw bad("ALREADY_FINISHED");
    const tr = ev.filter((e) => e.type === "tool_result"), rq = ev.filter((e) => e.type === "tool_request");
    if (tr.length !== cp.results.length) throw bad("TRACE_RESULTS_COUNT", `${tr.length} trace results vs ${cp.results.length} recorded`);
    tr.forEach((e, i) => {
      const p = e.payload as { result_hash: string; request: unknown };
      const r = cp.results[i]!;
      if (p.result_hash !== r.result_hash || hashOf(p.request) !== hashOf(r.request)) throw bad("TRACE_RESULT_MISMATCH", `result ${i}`);
    });
    const last = ev[ev.length - 1]!;
    if (cp.phase === "AWAIT_TOOL") {
      if (!cp.pending || cp.pending.step !== cp.step) throw bad("PENDING");
      if (rq.length !== tr.length + 1 || last.type !== "tool_request" || hashOf((last.payload as { request: unknown }).request) !== hashOf(cp.pending.request)) throw bad("PENDING_MISMATCH");
    } else if (cp.phase === "AWAIT_DECISION") {
      if (cp.pending) throw bad("PENDING");
      if (rq.length !== tr.length) throw bad("DANGLING_REQUEST");
      if (cp.results.length === 0 ? false : last.type !== "tool_result" && last.type !== "resumed") throw bad("PHASE_MISMATCH");
    } else throw bad("PHASE");
    try { broker.restore(cp.results); } catch (e) { throw bad("RESTORE", (e as Error).message); }
    const inv = new Investigation(c, broker, meta, trace);
    inv.step = cp.step; inv.phase = cp.phase; inv.pending = cp.pending ? structuredClone(cp.pending) : null;
    inv.hist = structuredClone(cp.results); inv.hh = structuredClone(cp.hypothesis_history); inv.resumes = cp.resumes + 1;
    for (const r of cp.results) inv.noteRids(r);   // rebuilds the seen-evidence set and the "new since last decision" window exactly as the live run had it
    for (const e of cp.trace) if (e.type === "hypothesis_revision") { const rv = e.payload as RevisionEvent; inv.revisions.push(rv); inv.ledgerWarnings.push(...rv.warnings); }
    trace.add("resumed", broker.stats.virtual_ms, { from_step: cp.step, phase: cp.phase, restored_results: cp.results.length, prior_head: cp.trace_head, resumes: inv.resumes });
    return inv;
  }
}
