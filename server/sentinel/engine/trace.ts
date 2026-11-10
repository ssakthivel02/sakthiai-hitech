import { hashOf, sha256 } from "./canon";

export interface TraceEvent { seq: number; type: string; vt: number; payload: unknown; prev: string; hash: string }
export const genesis = (caseId: string): string => sha256("GENESIS:" + caseId);

export class TraceBuilder {
  readonly events: TraceEvent[] = [];
  private prev: string;
  constructor(caseId: string) { this.prev = genesis(caseId); }
  add(type: string, vt: number, payload: unknown): TraceEvent {
    const base = { seq: this.events.length, type, vt, payload, prev: this.prev };
    const ev: TraceEvent = { ...base, hash: hashOf(base) };
    this.events.push(ev); this.prev = ev.hash; return ev;
  }
  get head(): string { return this.prev; }
  /** Rebuild a builder from persisted events (resume). Throws if the chain is not intact for this case. */
  static fromEvents(caseId: string, events: TraceEvent[]): TraceBuilder {
    const chk = verifyChain(events, caseId);
    if (!chk.ok) throw new Error("TRACE_CHAIN_INVALID: " + chk.errors.slice(0, 3).join("; "));
    const b = new TraceBuilder(caseId);
    for (const e of events) b.events.push({ ...e });
    if (events.length) b.prev = events[events.length - 1]!.hash;
    return b;
  }
}

export interface TraceCheck { ok: boolean; errors: string[] }

/** Chain-only check (sequence, prev links, hashes, virtual time). Usable on a partial trace; says nothing about completeness. */
export function verifyChain(events: TraceEvent[], caseId: string): TraceCheck {
  const errors: string[] = [];
  let prev = genesis(caseId), lastVt = 0;
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    if (!e || typeof e !== "object") { errors.push(`malformed event at ${i}`); break; }
    if (e.seq !== i) errors.push(`seq gap at ${i}`);
    if (e.prev !== prev) errors.push(`prev-hash mismatch at ${i}`);
    const { hash, ...base } = e;
    if (hashOf(base) !== hash) errors.push(`hash mismatch at ${i}`);
    if (e.vt < lastVt) errors.push(`virtual time went backwards at ${i}`);
    lastVt = e.vt; prev = hash;
  }
  return { ok: errors.length === 0, errors };
}

/** Independent verification: hash chain + final answer consistency with recorded tool results. */
export function verifyTrace(events: TraceEvent[], caseId: string): TraceCheck {
  const errors: string[] = [];
  let prev = genesis(caseId);
  let lastVt = 0;
  const evidence = new Map<string, { quarantined: boolean; tool: string }>();
  const lastCallSeq = new Set<number>();
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    if (e.seq !== i) errors.push(`seq gap at ${i}`);
    if (e.prev !== prev) errors.push(`prev-hash mismatch at ${i}`);
    const { hash, ...base } = e;
    if (hashOf(base) !== hash) errors.push(`hash mismatch at ${i}`);
    if (e.vt < lastVt) errors.push(`virtual time went backwards at ${i}`);
    lastVt = e.vt; prev = hash;
    if (e.type === "tool_result") {
      const p = e.payload as { request: { tool: string }; records: Array<{ rid: string; quarantined: boolean }>; result_hash: string; replayed: boolean };
      for (const r of p.records) evidence.set(r.rid, { quarantined: r.quarantined, tool: p.request.tool });
      lastCallSeq.add(i);
    }
  }
  if (events.length === 0) errors.push("empty trace");
  else {
    if (events[0]!.type !== "run_start") errors.push("first event is not run_start");
    const last = events[events.length - 1]!;
    if (last.type !== "run_end") errors.push("last event is not run_end");
    const fin = events.filter((e) => e.type === "final");
    if (fin.length !== 1) errors.push(`expected exactly 1 final event, found ${fin.length}`);
    for (const f of fin) {
      const p = f.payload as { outcome: string; cited: string[]; contradictions: Array<[string, string]> };
      for (const rid of p.cited) {
        const ev = evidence.get(rid);
        if (!ev) errors.push(`final cites ${rid} which no tool_result produced`);
        else if (ev.quarantined) errors.push(`final cites quarantined record ${rid}`);
      }
      for (const [a, b] of p.contradictions) for (const rid of [a, b]) if (!evidence.has(rid)) errors.push(`contradiction cites unknown ${rid}`);
    }
  }
  return { ok: errors.length === 0, errors };
}
