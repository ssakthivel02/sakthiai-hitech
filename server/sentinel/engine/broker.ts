import type { CaseDoc, EvRecord, ToolRequest, ToolResult, WorldObs } from "./types";
import { WRITE_TOOLS } from "./types";
import type { BackendOutcome, ToolTransport } from "./transport";
import { hashOf, sha256 } from "./canon";

/** Instruction-like content inside tool output is DATA, never instructions. Matching records are quarantined. */
export const INJECTION_PATTERNS: Array<{ id: string; re: RegExp }> = [
  { id: "override-instructions", re: /\b(ignore|disregard|forget)\b[^.\n]{0,40}\b(instructions?|rules|guidelines|prior|previous)\b/i },
  { id: "role-impersonation", re: /(<<\s*system\s*>>|\b(assistant|system|agent)s?\s*(instruction|prompt)\b)/i },
  { id: "addressed-to-ai", re: /(\bnote to (automated )?(assistants?|ai|agents?)\b|\bai agents?\s*:|\bautomated assistants?\b|\bautomation notice\b)/i },
  { id: "tool-invocation", re: new RegExp("\\b(" + WRITE_TOOLS.map((t) => t.replace(".", "\\.")).join("|") + ")\\b", "i") },
  { id: "exfiltration", re: /\b(upload|send|post|exfiltrate|forward)\b[^.\n]{0,80}\bhttps?:\/\//i },
  { id: "verdict-steering", re: /\b(mark|state|report|declare|conclude)\b[^.\n]{0,40}\b(resolved|root cause|the cause|remediation completed)\b/i },
];
const MAX_LINE = 600, MAX_RECORDS = 50;
const ALLOWED_ARGS = new Set(["window_min", "query"]);
const TIMEOUT_VMS = 5000, ERROR_VMS = 1000;
const CONTRACT_VIOLATION = "ADAPTER_CONTRACT_VIOLATION";
const DENY_REASONS = /^(BAD_REQUEST:.+|WRITE_TOOLS_DISABLED|TOOL_NOT_ALLOWED|OUT_OF_SCOPE|BUDGET_EXHAUSTED|TIME_EXHAUSTED)$/;

export interface BrokerStats {
  calls_used: number; denied: number; denied_write_attempts: number; denied_out_of_scope: number; duplicates_suppressed: number;
  retries: number; timeouts: number; virtual_ms: number; quarantined_records: number; backend_execs: number;
  /** present only when at least one transport error occurred */ transport_errors?: number;
}
export interface EvidenceItem extends EvRecord { tool: string; target: string }
export interface AsyncCallOptions { signal?: AbortSignal; attemptTimeoutMs?: number }

/** Thrown by callAsync when the caller aborts mid-flight. The call is not recorded and its budget unit is returned. */
export class CallAborted extends Error { constructor() { super("CALL_ABORTED"); this.name = "CallAborted"; } }
/** Thrown by restore when recorded results are inconsistent. Fail closed: nothing is restored. */
export class RestoreError extends Error {
  readonly code: string;
  constructor(code: string, detail = "") { super(detail ? `${code}: ${detail}` : code); this.name = "RestoreError"; this.code = code; }
}

const freshStats = (): BrokerStats => ({ calls_used: 0, denied: 0, denied_write_attempts: 0, denied_out_of_scope: 0, duplicates_suppressed: 0, retries: 0, timeouts: 0, virtual_ms: 0, quarantined_records: 0, backend_execs: 0 });
const isRetryable = (o: BackendOutcome): boolean => o.kind === "timeout" || (o.kind === "error" && o.code !== CONTRACT_VIOLATION);
const norm = (t: string): string => t.normalize("NFKC").replace(/[​-‏⁠﻿­]/g, "");
const injectionHit = (text: string): string | undefined => INJECTION_PATTERNS.find((p) => p.re.test(norm(text)))?.id;

export class Broker {
  readonly stats: BrokerStats = freshStats();
  readonly results: ToolResult[] = [];
  readonly evidence = new Map<string, EvidenceItem>();
  /** adapter contract violations observed (tenant/tool/target mismatch, malformed observation). Never forwarded to the policy. */
  readonly violations: Array<{ tool: string; target: string; reason: string }> = [];
  private readonly c: CaseDoc;
  private readonly transport: ToolTransport;
  private readonly scope: Set<string>;
  private readonly allowed: Set<string>;
  private readonly seen = new Map<string, ToolResult>();
  private seq = 0;
  private busy = false;
  constructor(caseDoc: CaseDoc, transport: ToolTransport) {
    this.c = caseDoc; this.transport = transport;
    this.scope = new Set([...caseDoc.inventory.services, ...caseDoc.inventory.hosts]);
    this.allowed = new Set(caseDoc.allowed_tools.filter((t) => !(WRITE_TOOLS as readonly string[]).includes(t)));
  }
  get budgetLeft(): number { return this.c.limits.max_tool_calls - this.stats.calls_used; }
  get timeLeft(): number { return this.c.limits.max_virtual_ms - this.stats.virtual_ms; }

  private deny(req: ToolRequest, reason: string): ToolResult {
    this.stats.denied++;
    const r: ToolResult = { seq: this.seq++, request: req, status: "DENIED", deny_reason: reason, records: [], quarantined: [], attempts: 0, replayed: false, virtual_ms: 0, result_hash: "" };
    r.result_hash = hashOf({ ...r, result_hash: undefined }); this.results.push(r); return r;
  }

  /** Strict shape validation. Fails closed. */
  private parse(raw: unknown): { req: ToolRequest } | { bad: string; tool: string; target: string } {
    const o = raw as Record<string, unknown> | null;
    const bad = (why: string) => ({ bad: "BAD_REQUEST:" + why, tool: String((o as any)?.tool ?? ""), target: String((o as any)?.target ?? "") });
    if (!o || typeof o !== "object" || Array.isArray(o)) return bad("not-an-object");
    for (const k of Object.keys(o)) if (!["tool", "target", "args"].includes(k)) return bad("unknown-field:" + k);
    if (typeof o.tool !== "string" || typeof o.target !== "string") return bad("tool-and-target-must-be-strings");
    if (o.target.length === 0 || o.target.length > 120 || /[^\w.\-:]/.test(o.target)) return bad("target-format");
    let args: Record<string, unknown> | undefined;
    if (o.args !== undefined) {
      if (typeof o.args !== "object" || o.args === null || Array.isArray(o.args)) return bad("args-not-object");
      for (const [k, v] of Object.entries(o.args)) {
        if (!ALLOWED_ARGS.has(k)) return bad("unknown-arg:" + k);
        if (k === "window_min" && !(Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 120)) return bad("window_min-range");
        if (k === "query" && !(typeof v === "string" && v.length <= 200)) return bad("query-type");
      }
      args = o.args as Record<string, unknown>;
    }
    return { req: { tool: o.tool, target: o.target, ...(args ? { args } : {}) } };
  }

  /** Rules 1-5 (shape, write-deny, allow-list, scope, replay, budgets). Returns a finished result, or the request cleared for execution. */
  private admit(raw: unknown): { done: ToolResult } | { req: ToolRequest; key: string } {
    const p = this.parse(raw);
    if ("bad" in p) return { done: this.deny({ tool: p.tool, target: p.target }, p.bad) };
    const req = p.req;
    if ((WRITE_TOOLS as readonly string[]).includes(req.tool)) { this.stats.denied_write_attempts++; return { done: this.deny(req, "WRITE_TOOLS_DISABLED") }; }
    if (!this.allowed.has(req.tool)) return { done: this.deny(req, "TOOL_NOT_ALLOWED") };
    // tenant/scope: identical answer for unknown and foreign targets (no existence oracle)
    if (!this.scope.has(req.target)) { this.stats.denied_out_of_scope++; return { done: this.deny(req, "OUT_OF_SCOPE") }; }
    // duplicate execution -> replay stored result, no transport call, no budget
    const key = hashOf({ t: req.tool, g: req.target, a: req.args ?? null });
    const prior = this.seen.get(key);
    if (prior) {
      this.stats.duplicates_suppressed++;
      const r: ToolResult = { ...prior, seq: this.seq++, replayed: true, virtual_ms: 0, result_hash: "" };
      r.result_hash = hashOf({ ...r, result_hash: undefined }); this.results.push(r); return { done: r };
    }
    if (this.stats.calls_used >= this.c.limits.max_tool_calls) return { done: this.deny(req, "BUDGET_EXHAUSTED") };
    if (this.stats.virtual_ms >= this.c.limits.max_virtual_ms) return { done: this.deny(req, "TIME_EXHAUSTED") };
    return { req, key };
  }

  /** Defence in depth against a buggy or hostile adapter: whatever it returns must belong to this tenant, tool and target. */
  private checked(req: ToolRequest, out: BackendOutcome): BackendOutcome {
    if (out.kind !== "ok") return out;
    const fail = (reason: string): BackendOutcome => { this.violations.push({ tool: req.tool, target: req.target, reason }); return { kind: "error", virtual_ms: ERROR_VMS, code: CONTRACT_VIOLATION }; };
    if (!Array.isArray(out.obs) || typeof out.virtual_ms !== "number" || !(out.virtual_ms >= 0)) return fail("malformed-outcome");
    for (const ob of out.obs) {
      if (!ob || typeof ob !== "object") return fail("malformed-observation");
      if (ob.tenant !== this.c.tenant) return fail("foreign-tenant-observation");
      if (ob.tool !== req.tool || ob.target !== req.target) return fail("observation-for-other-tool-or-target");
      if (typeof ob.obs_id !== "string" || typeof ob.source_system !== "string" || !Array.isArray(ob.records)) return fail("malformed-observation");
      for (const r of ob.records) if (!r || typeof r.text !== "string" || typeof r.ts !== "string" || typeof r.level !== "string") return fail("malformed-record");
    }
    return out;
  }

  private settle(req: ToolRequest, key: string, outs: BackendOutcome[]): ToolResult {
    const attempts = outs.length, vms = outs.reduce((a, o) => a + o.virtual_ms, 0);
    this.stats.backend_execs += attempts; this.stats.retries += attempts - 1; this.stats.virtual_ms += vms;
    const last = outs[attempts - 1]!;
    let res: ToolResult;
    if (last.kind === "timeout") {
      this.stats.timeouts++;
      res = { seq: this.seq++, request: req, status: "TIMEOUT", records: [], quarantined: [], attempts, replayed: false, virtual_ms: vms, result_hash: "" };
    } else if (last.kind === "error") {
      this.stats.transport_errors = (this.stats.transport_errors ?? 0) + 1;
      const code = /^[A-Z_]{1,40}$/.test(last.code) ? last.code : "TRANSPORT_ERROR";
      res = { seq: this.seq++, request: req, status: "ERROR", error: code, records: [], quarantined: [], attempts, replayed: false, virtual_ms: vms, result_hash: "" };
    } else {
      const { records, quarantined } = this.sanitize(last.obs);
      res = { seq: this.seq++, request: req, status: records.length ? "OK" : "NO_DATA", ...(last.obs[0] ? { source_system: last.obs[0].source_system } : {}), records, quarantined, attempts, replayed: false, virtual_ms: vms, result_hash: "" };
      for (const r of records) this.evidence.set(r.rid, { ...r, tool: req.tool, target: req.target });
      this.stats.quarantined_records += quarantined.length;
    }
    res.result_hash = hashOf({ ...res, result_hash: undefined });
    this.seen.set(key, res); this.results.push(res); return res;
  }

  /** Synchronous path (sync transports only, e.g. FakeBackend). */
  call(raw: unknown): ToolResult {
    if (this.busy) throw new Error("BROKER_BUSY");
    const a = this.admit(raw);
    if ("done" in a) return a.done;
    const { req, key } = a;
    this.stats.calls_used++;
    const outs: BackendOutcome[] = [];
    try {
      for (;;) {
        let o: BackendOutcome;
        try {
          const r = this.transport.exec(this.c.tenant, req.tool, req.target, req.args ? { args: req.args } : undefined);
          if (r instanceof Promise) { r.catch(() => undefined); throw new TypeError("ASYNC_TRANSPORT_IN_SYNC_CALL"); }
          o = r;
        } catch (e) {
          if (e instanceof TypeError && e.message === "ASYNC_TRANSPORT_IN_SYNC_CALL") throw e;
          o = { kind: "error", virtual_ms: ERROR_VMS, code: "TRANSPORT_ERROR" };
        }
        o = this.checked(req, o); outs.push(o);
        if (!isRetryable(o) || outs.length > this.c.limits.max_retries_per_call) break;
      }
    } catch (e) { this.stats.calls_used--; throw e; }
    return this.settle(req, key, outs);
  }

  private attemptAsync(req: ToolRequest, o: AsyncCallOptions): Promise<BackendOutcome> {
    return new Promise<BackendOutcome>((resolve, reject) => {
      let done = false, timer: ReturnType<typeof setTimeout> | undefined;
      const inner = new AbortController();
      const onAbort = () => fin(() => reject(new CallAborted()));
      const fin = (fn: () => void) => { if (done) return; done = true; if (timer) clearTimeout(timer); o.signal?.removeEventListener("abort", onAbort); inner.abort(); fn(); };
      if (o.signal) { if (o.signal.aborted) return fin(() => reject(new CallAborted())); o.signal.addEventListener("abort", onAbort, { once: true }); }
      if (o.attemptTimeoutMs && o.attemptTimeoutMs > 0) timer = setTimeout(() => fin(() => resolve({ kind: "timeout", virtual_ms: TIMEOUT_VMS })), o.attemptTimeoutMs);
      Promise.resolve().then(() => this.transport.exec(this.c.tenant, req.tool, req.target, { signal: inner.signal, ...(req.args ? { args: req.args } : {}) }))
        .then((r) => fin(() => resolve(r)), () => fin(() => resolve({ kind: "error", virtual_ms: ERROR_VMS, code: "TRANSPORT_ERROR" })));
    });
  }

  /** Asynchronous path. One call at a time. Abort mid-flight returns the budget unit and records nothing (at-least-once window; tools are read-only). */
  async callAsync(raw: unknown, o: AsyncCallOptions = {}): Promise<ToolResult> {
    if (this.busy) throw new Error("BROKER_BUSY");
    const a = this.admit(raw);
    if ("done" in a) return a.done;
    const { req, key } = a;
    this.busy = true; this.stats.calls_used++;
    const outs: BackendOutcome[] = [];
    try {
      for (;;) {
        const out = this.checked(req, await this.attemptAsync(req, o)); outs.push(out);
        if (!isRetryable(out) || outs.length > this.c.limits.max_retries_per_call) break;
      }
    } catch (e) { this.stats.calls_used--; throw e; }
    finally { this.busy = false; }
    return this.settle(req, key, outs);
  }

  private sanitize(obs: WorldObs[]): { records: EvRecord[]; quarantined: ToolResult["quarantined"] } {
    const records: EvRecord[] = [], quarantined: ToolResult["quarantined"] = [];
    for (const ob of obs) {
      ob.records.forEach((r, i) => {
        if (records.length >= MAX_RECORDS) return;
        const rid = `${ob.obs_id}#${i}`;
        // eslint-disable-next-line no-control-regex
        let text = r.text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ");
        if (text.length > MAX_LINE) text = text.slice(0, MAX_LINE) + " [truncated]";
        // match on a normalised copy (NFKC, zero-width/format characters removed); the stored text keeps the sanitised original
        const hit = injectionHit(text);
        if (hit) {
          quarantined.push({ rid, pattern: hit, original_sha256: sha256(r.text) });
          records.push({ rid, obs_id: ob.obs_id, ts: r.ts, level: r.level, text: `[QUARANTINED: instruction-like content removed; pattern=${hit}]`, quarantined: true });
        } else records.push({ rid, obs_id: ob.obs_id, ts: r.ts, level: r.level, text, quarantined: false });
      });
    }
    return { records, quarantined };
  }

  /**
   * Rebuild seen-map, stats, evidence and sequence from previously recorded results (crash/resume).
   * Fails closed (RestoreError, nothing applied) if the recorded results could not have been produced by this broker for this case.
   * Restored budgets and dedupe are therefore a pure function of the recorded results.
   */
  restore(results: ToolResult[]): void {
    if (this.results.length > 0 || this.seq > 0) throw new RestoreError("BROKER_NOT_EMPTY");
    const stats = freshStats(); const seen = new Map<string, ToolResult>(); const evidence = new Map<string, EvidenceItem>();
    const maxAttempts = this.c.limits.max_retries_per_call + 1;
    results.forEach((r, i) => {
      const at = `result ${i}`;
      if (!r || typeof r !== "object") throw new RestoreError("MALFORMED", at);
      if (r.seq !== i) throw new RestoreError("SEQ", `${at} has seq ${r.seq}`);
      if (hashOf({ ...r, result_hash: undefined }) !== r.result_hash) throw new RestoreError("HASH", at);
      if (r.status === "DENIED") {
        if (typeof r.deny_reason !== "string" || !DENY_REASONS.test(r.deny_reason)) throw new RestoreError("DENY_REASON", at);
        if (r.records.length || r.attempts !== 0 || r.replayed) throw new RestoreError("DENIED_NOT_EMPTY", at);
        stats.denied++;
        if (r.deny_reason === "WRITE_TOOLS_DISABLED") stats.denied_write_attempts++;
        if (r.deny_reason === "OUT_OF_SCOPE") stats.denied_out_of_scope++;
        return;
      }
      const p = this.parse(r.request);
      if ("bad" in p) throw new RestoreError("REQUEST_SHAPE", at);
      const req = p.req;
      if (!this.allowed.has(req.tool)) throw new RestoreError("TOOL_NOT_ALLOWED", `${at} ${req.tool}`);
      if (!this.scope.has(req.target)) throw new RestoreError("OUT_OF_SCOPE", `${at} ${req.target}`);
      const key = hashOf({ t: req.tool, g: req.target, a: req.args ?? null });
      if (r.replayed) {
        const prior = seen.get(key);
        if (!prior) throw new RestoreError("REPLAY_WITHOUT_ORIGINAL", at);
        if (prior.status !== r.status || hashOf(prior.records) !== hashOf(r.records) || r.virtual_ms !== 0) throw new RestoreError("REPLAY_MISMATCH", at);
        stats.duplicates_suppressed++;
        return;
      }
      if (seen.has(key)) throw new RestoreError("DUPLICATE_EXECUTION", at);
      if (!Number.isInteger(r.attempts) || r.attempts < 1 || r.attempts > maxAttempts) throw new RestoreError("ATTEMPTS", at);
      if (typeof r.virtual_ms !== "number" || !(r.virtual_ms >= 0)) throw new RestoreError("VIRTUAL_MS", at);
      stats.calls_used++; stats.backend_execs += r.attempts; stats.retries += r.attempts - 1; stats.virtual_ms += r.virtual_ms;
      if (r.status === "TIMEOUT") { stats.timeouts++; if (r.records.length) throw new RestoreError("TIMEOUT_HAS_RECORDS", at); }
      else if (r.status === "ERROR") { stats.transport_errors = (stats.transport_errors ?? 0) + 1; if (r.records.length) throw new RestoreError("ERROR_HAS_RECORDS", at); }
      else if (r.status === "OK" || r.status === "NO_DATA") {
        if ((r.status === "OK") !== (r.records.length > 0)) throw new RestoreError("STATUS_RECORDS", at);
        const qids = new Set(r.quarantined.map((q) => q.rid));
        for (const rec of r.records) {
          if (typeof rec.rid !== "string" || typeof rec.text !== "string" || typeof rec.obs_id !== "string" || !rec.rid.startsWith(rec.obs_id + "#")) throw new RestoreError("RECORD_SHAPE", `${at} ${String(rec.rid)}`);
          if (rec.quarantined) { if (!qids.has(rec.rid) || !rec.text.startsWith("[QUARANTINED:")) throw new RestoreError("QUARANTINE_MISMATCH", `${at} ${rec.rid}`); }
          else if (qids.has(rec.rid)) throw new RestoreError("QUARANTINE_MISMATCH", `${at} ${rec.rid}`);
          else if (rec.text.length > MAX_LINE + 12) throw new RestoreError("RECORD_TOO_LONG", `${at} ${rec.rid}`);
          else if (injectionHit(rec.text)) throw new RestoreError("UNSANITISED_RECORD", `${at} ${rec.rid}`); // poisoned checkpoint: instruction-like text presented as clean evidence
          evidence.set(rec.rid, { ...rec, tool: req.tool, target: req.target });
        }
        if (r.records.length > MAX_RECORDS) throw new RestoreError("TOO_MANY_RECORDS", at);
        stats.quarantined_records += r.quarantined.length;
      } else throw new RestoreError("STATUS", at);
      seen.set(key, r);
    });
    if (stats.calls_used > this.c.limits.max_tool_calls) throw new RestoreError("BUDGET_OVERRUN", `${stats.calls_used} > ${this.c.limits.max_tool_calls}`);
    // commit
    Object.assign(this.stats, stats); if (stats.transport_errors === undefined) delete this.stats.transport_errors;
    for (const [k, v] of seen) this.seen.set(k, v);
    for (const [k, v] of evidence) this.evidence.set(k, v);
    for (const r of results) this.results.push(r);
    this.seq = results.length;
  }
}
