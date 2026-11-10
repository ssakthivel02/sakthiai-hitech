import { verifyChain, verifyTrace } from "./engine/trace";
import type { TraceEvent } from "./engine/trace";
import type { RevisionEvent } from "./engine/ledger";
import type { CallStatus, EvRecord, FinalAnswer, Hypothesis, ToolRequest, ToolResult } from "./engine/types";
import { isTerminalStatus } from "./types";
import type { DiagnosticBinding, InvestigationRecord, StoredEvent } from "./types";

/**
 * Pure projection of (investigation row + stored events) into what the UI and the report show. Nothing here is invented: every field is read
 * from a persisted event or the row, and an empty investigation yields empty lists (never placeholder data).
 */

export interface EvidenceView { rid: string; ts: string; level: string; text: string; quarantined: boolean; tool: string; target: string; step: number; cited: boolean; callIndex: number }
export interface ToolCallView {
  index: number; step: number; tool: string; target: string; args: Record<string, unknown> | null;
  status: "PENDING" | CallStatus; denyReason: string | null; error: string | null; attempts: number; replayed: boolean; durationMs: number;
  sourceSystem: string | null; recordCount: number; quarantinedCount: number; rids: string[];
}
export interface DecisionView { step: number; type: "CALL" | "FINAL"; rationale: string | null; request: ToolRequest | null; hypotheses: Hypothesis[]; model: { attempt: number; modelCalls: number; reasoningChars: number | null; transport: string; provenance: ModelProvenanceView | null; tokensIn: number | null; tokensOut: number | null } | null }
export interface ModelProvenanceView { providerId: string; modelId: string; profileId: string; providerKind: string; billingMode: string; configSource: string; usageSource: string; latencyMs: number; runtimeClass: string | null; endpointProfile: string | null; invokedAt: string | null; correlationId: string | null; verification: string | null; fallbackOccurred: boolean | null; cost: { amount: number; unit: string; estimated: boolean } | null }
/**
 * Which model produced the decisions in this investigation, as REPORTED by the SakthiAI Provider Gateway and stored in the trace.
 * UNVERIFIED means no gateway identity was recorded (older traces, or a transport that does not know its provider): nothing is inferred.
 */
export interface ModelIdentityView {
  status: "REPORTED" | "PARTIAL" | "UNVERIFIED";
  decisions: number; identified: number;
  models: Array<{ providerId: string; modelId: string; profileId: string; providerKind: string; billingMode: string; configSource: string; decisions: number; runtimeClass: string | null; endpointProfile: string | null }>;
  /** Decisions answered after another candidate was tried or skipped (null when no decision recorded the field). */
  fallbackDecisions: number | null;
  /** Sum of gateway-computed cost (configured rate x reported tokens); null unless every identified decision carried one in a single unit. */
  cost: { amount: number; unit: string; estimated: boolean } | null;
  tokens: { prompt: number; completion: number; decisionsCounted: number } | null;
  note: string;
}
export interface TimelineItem { seq: number; kind: string; tone: "info" | "ok" | "warn" | "bad"; label: string; detail: string | null; step: number | null }
export interface FinalView {
  outcome: FinalAnswer["outcome"]; label: string; summary: string; confidence: number; abstainReason: string | null;
  citations: EvidenceView[]; contradictions: Array<[EvidenceView | null, EvidenceView | null]>;
  remediation: { text: string; executed: false; requiresApproval: true; status: "PROPOSED_NOT_EXECUTED" };
  nextSafeSteps: string[];
}
export interface VerificationView {
  passed: boolean; mode: "structural"; note: string; rejectedChecks: string[]; ledgerRejected: boolean; ledgerWarnings: string[]; redactions: string[];
}
export interface IntegrityView { chainOk: boolean; complete: boolean; errors: string[]; head: string | null; eventCount: number }
export interface InvestigationView {
  investigation: {
    id: string; title: string; severity: string; service: string; firedAt: string; description: string; objective: string; operatorNotes: string[];
    inventory: { services: string[]; hosts: string[] }; allowedTools: string[]; limits: InvestigationRecord["limits"];
    bindings: Array<Pick<DiagnosticBinding, "tool" | "connectorId" | "mcpTool">>;
    status: InvestigationRecord["status"]; stopReason: string | null; errorMessage: string | null; taskId: string | null;
    createdAt: string; startedAt: string | null; finishedAt: string | null; createdByUserId: number;
  };
  progress: { phase: "queued" | "deciding" | "calling" | "finished"; step: number; maxSteps: number; callsUsed: number; maxCalls: number; resumes: number; percent: number };
  timeline: TimelineItem[];
  toolCalls: ToolCallView[];
  evidence: EvidenceView[];
  decisions: DecisionView[];
  modelIdentity: ModelIdentityView;
  hypotheses: { latest: Hypothesis[]; history: Array<{ step: number; hypotheses: Hypothesis[] }>; revisions: RevisionEvent[] };
  final: FinalView | null;
  verification: VerificationView | null;
  integrity: IntegrityView;
}

type P = Record<string, any>;
const arr = <T>(x: unknown): T[] => (Array.isArray(x) ? (x as T[]) : []);
const numOrNull = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : null);
const idText = (x: unknown): string => String(x ?? "").replace(/[^A-Za-z0-9 _.:/@+*\-]/g, "?").slice(0, 96);
/** Trace data is ours, but the view still accepts only well-formed identity and never trusts shape. */
function parseProvenance(x: unknown): ModelProvenanceView | null {
  const o = x as P | null;
  if (!o || typeof o !== "object" || typeof o.provider_id !== "string" || typeof o.model_id !== "string" || !o.provider_id || !o.model_id) return null;
  return { providerId: idText(o.provider_id), modelId: idText(o.model_id), profileId: idText(o.profile_id), providerKind: idText(o.provider_kind), billingMode: idText(o.billing_mode), configSource: idText(o.config_source), usageSource: idText(o.usage_source), latencyMs: numOrNull(o.latency_ms) ?? 0,
    runtimeClass: typeof o.runtime_class === "string" ? idText(o.runtime_class) : null, endpointProfile: typeof o.endpoint_profile === "string" ? idText(o.endpoint_profile) : null,
    invokedAt: typeof o.invoked_at === "string" && !Number.isNaN(Date.parse(o.invoked_at)) ? new Date(o.invoked_at).toISOString() : null, correlationId: typeof o.correlation_id === "string" ? idText(o.correlation_id) : null,
    verification: typeof o.verification === "string" ? idText(o.verification) : null, fallbackOccurred: typeof o.fallback_occurred === "boolean" ? o.fallback_occurred : null,
    cost: o.cost && typeof o.cost === "object" && numOrNull((o.cost as P).amount) !== null ? { amount: numOrNull((o.cost as P).amount)!, unit: idText((o.cost as P).unit).slice(0, 8), estimated: (o.cost as P).estimated !== false } : null };
}
const IDENTITY_NOTE: Record<ModelIdentityView["status"], string> = {
  REPORTED: "Provider and model were reported by the SakthiAI Provider Gateway for every model-produced decision and are recorded in the trace. This identifies what answered; it does not measure accuracy.",
  PARTIAL: "Only some decisions carry a gateway-reported provider/model (for example an investigation resumed from an older record). The rest are UNVERIFIED.",
  UNVERIFIED: "No provider or model identity was recorded for this investigation, so none is claimed. Prompt and response hashes are in the trace.",
};
function summariseIdentity(ds: DecisionView[]): ModelIdentityView {
  const modelled = ds.filter((d) => d.model);
  const ident = modelled.filter((d) => d.model!.provenance);
  const map = new Map<string, ModelIdentityView["models"][number]>();
  for (const d of ident) {
    const m = d.model!.provenance!; const key = `${m.providerId}|${m.modelId}|${m.profileId}`;
    const cur = map.get(key); if (cur) cur.decisions++; else map.set(key, { providerId: m.providerId, modelId: m.modelId, profileId: m.profileId, providerKind: m.providerKind, billingMode: m.billingMode, configSource: m.configSource, decisions: 1, runtimeClass: m.runtimeClass, endpointProfile: m.endpointProfile });
  }
  const counted = modelled.filter((d) => d.model!.tokensIn !== null || d.model!.tokensOut !== null);
  const status: ModelIdentityView["status"] = !ident.length ? "UNVERIFIED" : ident.length === modelled.length ? "REPORTED" : "PARTIAL";
  const fb = ident.filter((d) => d.model!.provenance!.fallbackOccurred !== null);
  const costs = ident.map((d) => d.model!.provenance!.cost);
  const unit = costs[0]?.unit;
  const costOk = ident.length > 0 && costs.every((c) => c && c.unit === unit);
  return { status, decisions: modelled.length, identified: ident.length, models: [...map.values()], note: IDENTITY_NOTE[status],
    fallbackDecisions: fb.length ? fb.filter((d) => d.model!.provenance!.fallbackOccurred === true).length : null,
    cost: costOk ? { amount: Math.round(costs.reduce((n, c) => n + c!.amount, 0) * 1e6) / 1e6, unit: unit!, estimated: costs.some((c) => c!.estimated) } : null,
    tokens: counted.length ? { prompt: counted.reduce((n, d) => n + (d.model!.tokensIn ?? 0), 0), completion: counted.reduce((n, d) => n + (d.model!.tokensOut ?? 0), 0), decisionsCounted: counted.length } : null };
}
const trunc = (s: string, n = 140) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const VERIFY_NOTE = "Passing means: schema valid, every citation exists and is not quarantined, a diagnosis cites at least 2 records from at least 2 different tools, no false claim of an executed action, and the remediation is marked unexecuted and approval-required. It does not prove the diagnosis is correct.";

export function buildView(row: InvestigationRecord, events: StoredEvent[]): InvestigationView {
  const trace = events as TraceEvent[];
  const results: Array<{ e: StoredEvent; p: P; index: number; step: number }> = [];
  const decisions: DecisionView[] = [];
  const requests: Array<{ step: number; request: ToolRequest }> = [];
  const revisions: RevisionEvent[] = [];
  const timeline: TimelineItem[] = [];
  let step = 0, resumes = 0, ended = false, ledgerRejected = false;
  let finalPayload: FinalAnswer | null = null; let verifierFatal: string[] = [], redactions: string[] = [], ledgerWarnings: string[] = [];
  let verifierRejected = false;

  for (const e of events) {
    const p = (e.payload ?? {}) as P;
    switch (e.type) {
      case "run_start": timeline.push({ seq: e.seq, kind: e.type, tone: "info", label: "Investigation started", detail: `Read-only tools: ${arr<string>(p.allowed_tools).join(", ") || "none"}`, step: null }); break;
      case "decision": {
        step = Math.max(step, Number(p.step) || 0);
        const hyps = arr<Hypothesis>(p.hypotheses);
        const d: DecisionView = { step: Number(p.step) || 0, type: p.type === "FINAL" ? "FINAL" : "CALL", rationale: typeof p.rationale === "string" ? p.rationale : null, request: p.request ?? null, hypotheses: hyps,
          model: p.model_meta ? { attempt: Number(p.model_meta.attempt) || 0, modelCalls: Number(p.model_meta.model_calls) || 0, reasoningChars: p.model_meta.reasoning_chars ?? null, transport: String(p.model_meta.transport ?? ""), provenance: parseProvenance(p.model_meta.provenance), tokensIn: numOrNull(p.model_meta.tokens_in), tokensOut: numOrNull(p.model_meta.tokens_out) } : null };
        decisions.push(d);
        timeline.push({ seq: e.seq, kind: e.type, tone: "info", step: d.step,
          label: d.type === "CALL" ? `Requested ${d.request?.tool ?? "tool"} on ${d.request?.target ?? "?"}` : "Proposed a conclusion", detail: d.rationale ? trunc(d.rationale, 240) : null });
        break;
      }
      case "tool_request": requests.push({ step: Number(p.step) || 0, request: p.request }); break;
      case "tool_result": {
        const index = results.length; results.push({ e, p, index, step: Number(p.step) || 0 });
        const tone = p.status === "OK" ? "ok" : p.status === "NO_DATA" ? "info" : "warn";
        const q = arr(p.quarantined).length;
        timeline.push({ seq: e.seq, kind: e.type, tone, step: Number(p.step) || 0, label: `${p.request?.tool ?? "tool"} → ${p.status}${p.deny_reason ? ` (${String(p.deny_reason).split(":")[0]})` : ""}`,
          detail: `${arr(p.records).length} record(s)${q ? `, ${q} quarantined` : ""}${p.replayed ? ", replayed from earlier result" : ""}` });
        break;
      }
      case "hypothesis_revision": { const r = p as unknown as RevisionEvent; revisions.push(r);
        timeline.push({ seq: e.seq, kind: e.type, tone: r.warnings?.length ? "warn" : "info", step: r.step ?? null,
          label: r.leader_changed ? `Leading hypothesis changed: ${r.leader_before ?? "none"} → ${r.leader_after ?? "none"}` : "Hypotheses revised", detail: r.warnings?.length ? `Ledger warning: ${r.warnings.join("; ")}` : r.justified ? "Justified by new evidence" : null }); break; }
      case "resumed": resumes = Math.max(resumes, Number(p.resumes) || resumes + 1); timeline.push({ seq: e.seq, kind: e.type, tone: "warn", step: Number(p.from_step) || null, label: "Resumed after an interruption", detail: `Restored ${p.restored_results ?? 0} earlier tool result(s); no completed call was repeated` }); break;
      case "cancelled": timeline.push({ seq: e.seq, kind: e.type, tone: "warn", step: Number(p.step) || null, label: "Cancelled by operator", detail: p.in_flight ? `Stopped while a ${p.in_flight} call was in flight` : null }); break;
      case "policy_error": timeline.push({ seq: e.seq, kind: e.type, tone: "bad", step: Number(p.step) || null, label: "Model decision failed", detail: typeof p.message === "string" ? trunc(p.message, 200) : null }); break;
      case "call_after_limit_ignored": timeline.push({ seq: e.seq, kind: e.type, tone: "warn", step: Number(p.step) || null, label: "Budget reached; further tool request ignored", detail: null }); break;
      case "ledger_check": ledgerWarnings.push(...arr<string>(p.warnings)); timeline.push({ seq: e.seq, kind: e.type, tone: "warn", step: null, label: "Final answer checked against hypothesis ledger", detail: arr<string>(p.warnings).join("; ") || null }); break;
      case "ledger_reject": ledgerRejected = true; timeline.push({ seq: e.seq, kind: e.type, tone: "bad", step: null, label: "Conclusion rejected: inconsistent with hypothesis ledger", detail: arr<string>(p.blocking).join("; ") || null }); break;
      case "verifier_reject": verifierRejected = true; verifierFatal = arr<string>(p.fatal); timeline.push({ seq: e.seq, kind: e.type, tone: "bad", step: null, label: "Conclusion rejected by independent verification", detail: verifierFatal.slice(0, 4).map((f) => f.split(":").slice(0, 2).join(":")).join("; ") || null }); break;
      case "output_redacted": redactions = arr<string>(p.redactions); timeline.push({ seq: e.seq, kind: e.type, tone: "warn", step: null, label: "Unverifiable entities or instruction-like text redacted from the answer", detail: `${redactions.length} redaction(s)` }); break;
      case "final": finalPayload = p as unknown as FinalAnswer; timeline.push({ seq: e.seq, kind: e.type, tone: p.outcome === "DIAGNOSIS" ? "ok" : "warn", step: null, label: p.outcome === "DIAGNOSIS" ? `Diagnosis: ${p.label}` : "Abstained (no conclusion drawn)", detail: p.abstain_reason ? String(p.abstain_reason) : null }); break;
      case "run_end": ended = true; timeline.push({ seq: e.seq, kind: e.type, tone: "info", step: null, label: `Finished (${p.stop_reason})`, detail: null }); break;
      default: break;
    }
  }

  // Tool calls & evidence
  const cited = new Set<string>(finalPayload ? [...(finalPayload as FinalAnswer).cited, ...(finalPayload as FinalAnswer).contradictions.flat()] : []);
  const evidence: EvidenceView[] = [];
  const toolCalls: ToolCallView[] = results.map(({ p, index, step: st }) => {
    const rq = p.request as ToolRequest;
    const recs = arr<EvRecord>(p.records);
    for (const r of recs) evidence.push({ rid: r.rid, ts: r.ts, level: r.level, text: r.text, quarantined: r.quarantined, tool: rq.tool, target: rq.target, step: st, cited: cited.has(r.rid), callIndex: index });
    return { index, step: st, tool: rq.tool, target: rq.target, args: (rq.args as Record<string, unknown>) ?? null, status: p.status as CallStatus, denyReason: p.deny_reason ?? null, error: p.error ?? null, attempts: Number(p.attempts) || 0,
      replayed: Boolean(p.replayed), durationMs: Math.round(Number(p.virtual_ms) || 0), sourceSystem: p.source_system ?? null, recordCount: recs.length, quarantinedCount: arr(p.quarantined).length, rids: recs.map((r) => r.rid) };
  });
  // A request without a result yet is shown as a live PENDING call.
  if (!ended && requests.length > results.length) {
    const rq = requests[requests.length - 1]!;
    toolCalls.push({ index: toolCalls.length, step: rq.step, tool: rq.request.tool, target: rq.request.target, args: (rq.request.args as Record<string, unknown>) ?? null, status: "PENDING", denyReason: null, error: null, attempts: 0, replayed: false, durationMs: 0, sourceSystem: null, recordCount: 0, quarantinedCount: 0, rids: [] });
  }
  const byRid = new Map(evidence.map((e) => [e.rid, e]));

  const final: FinalView | null = finalPayload ? (() => {
    const f = finalPayload as FinalAnswer;
    return {
      outcome: f.outcome, label: f.label, summary: f.summary, confidence: f.confidence, abstainReason: f.abstain_reason ?? null,
      citations: f.cited.map((r) => byRid.get(r)).filter((x): x is EvidenceView => !!x),
      contradictions: f.contradictions.map(([a, b]) => [byRid.get(a) ?? null, byRid.get(b) ?? null] as [EvidenceView | null, EvidenceView | null]),
      remediation: { text: f.remediation.text, executed: false as const, requiresApproval: true as const, status: "PROPOSED_NOT_EXECUTED" as const },
      nextSafeSteps: f.next_safe_steps,
    };
  })() : null;

  const lastDecision = decisions[decisions.length - 1];
  const callsUsed = results.filter((r) => r.p.status !== "DENIED" && !r.p.replayed).length;
  const terminal = isTerminalStatus(row.status) || ended;
  const phase: InvestigationView["progress"]["phase"] = terminal ? "finished" : row.status === "QUEUED" ? "queued" : requests.length > results.length ? "calling" : "deciding";
  const percent = terminal ? 100 : row.status === "QUEUED" ? 0 : Math.min(95, Math.round((step / Math.max(1, row.limits.max_steps)) * 90));

  const chain = verifyChain(trace, row.id);
  const complete = ended ? verifyTrace(trace, row.id) : null;
  const integrity: IntegrityView = { chainOk: chain.ok, complete: complete?.ok ?? false, errors: [...(complete ? complete.errors : chain.errors)].slice(0, 10), head: events.length ? events[events.length - 1]!.hash : null, eventCount: events.length };

  return {
    investigation: {
      id: row.id, title: row.title, severity: row.severity, service: row.service, firedAt: row.firedAt, description: row.description, objective: row.objective, operatorNotes: row.operatorNotes,
      inventory: row.inventory, allowedTools: row.allowedTools, limits: row.limits, bindings: row.bindings.map((b) => ({ tool: b.tool, connectorId: b.connectorId, mcpTool: b.mcpTool })),
      status: row.status, stopReason: row.stopReason, errorMessage: row.errorMessage, taskId: row.taskId, createdAt: row.createdAt.toISOString(), startedAt: row.startedAt?.toISOString() ?? null,
      finishedAt: row.finishedAt?.toISOString() ?? null, createdByUserId: row.createdByUserId,
    },
    progress: { phase, step, maxSteps: row.limits.max_steps, callsUsed, maxCalls: row.limits.max_tool_calls, resumes, percent },
    timeline, toolCalls, evidence, decisions, modelIdentity: summariseIdentity(decisions),
    hypotheses: { latest: lastDecision?.hypotheses ?? [], history: decisions.map((d) => ({ step: d.step, hypotheses: d.hypotheses })), revisions },
    final,
    verification: ended ? { passed: !verifierRejected && !ledgerRejected, mode: "structural", note: VERIFY_NOTE, rejectedChecks: verifierFatal, ledgerRejected, ledgerWarnings: [...new Set(ledgerWarnings)], redactions } : null,
    integrity,
  };
}

/** List-row summary (no events needed). */
export const summaryRow = (r: InvestigationRecord) => ({
  id: r.id, title: r.title, severity: r.severity, service: r.service, status: r.status, outcome: r.outcome, label: r.label, confidence: r.confidence, verified: r.verified,
  stopReason: r.stopReason, eventCount: r.eventCount, createdAt: r.createdAt.toISOString(), startedAt: r.startedAt?.toISOString() ?? null, finishedAt: r.finishedAt?.toISOString() ?? null,
});
export type InvestigationSummary = ReturnType<typeof summaryRow>;
export type { ToolResult };
