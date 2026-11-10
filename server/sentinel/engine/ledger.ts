import type { FinalAnswer, Hypothesis } from "./types";
import type { EvidenceItem } from "./broker";

/**
 * Harness-side hypothesis revision audit. The policy (a stub today, a model later) reports a hypothesis ledger at every decision; THIS module,
 * which the policy cannot influence, checks that every revision is anchored in evidence the broker actually returned, and writes the result
 * into the hash-chained trace. It is a consistency audit, not a judge of correctness: a revision can be evidence-anchored and still wrong.
 */
export interface LedgerChange { label: string; kind: "ADDED" | "REMOVED" | "STATUS" | "SUPPORT_ADDED" | "SUPPORT_DROPPED"; from?: string; to?: string; evidence?: string[] }
export interface RevisionEvent {
  step: number; leader_before: string | null; leader_after: string | null; leader_changed: boolean; leader_basis: "none" | "prior" | "evidence";
  /** record ids first returned by the most recent tool call (the only evidence that can justify a revision made after it) */ new_evidence: string[];
  changes: LedgerChange[]; justified: boolean; warnings: string[];
}
/** Warnings that make a DIAGNOSIS untrustworthy when the ledger is run in strict mode. */
export const BLOCKING_WARNINGS = ["INVALID_REF", "LEADER_CHANGE_WITHOUT_NEW_EVIDENCE", "REVIVAL_WITHOUT_NEW_EVIDENCE", "FINAL_LABEL_NOT_LEADER", "FINAL_LABEL_NEVER_HYPOTHESISED"];
export const isBlocking = (w: string): boolean => BLOCKING_WARNINGS.includes(w.split(":")[0]!);

const cap = (s: string, n = 120): string => (s.length > n ? s.slice(0, n) : s);
/** Leader = highest-scoring LEADING/SUPPORTED hypothesis (ties: first listed). */
export function leaderOf(h: Hypothesis[]): Hypothesis | null {
  let best: Hypothesis | null = null;
  for (const x of h) if ((x.status === "LEADING" || x.status === "SUPPORTED") && (!best || x.score > best.score)) best = x;
  return best;
}
const validRefs = (refs: readonly string[] | undefined, ev: Map<string, EvidenceItem>): string[] => (refs ?? []).filter((r) => { const e = ev.get(r); return !!e && !e.quarantined; });

export function reviseLedger(a: { step: number; history: Hypothesis[][]; prev: Hypothesis[]; next: Hypothesis[]; evidence: Map<string, EvidenceItem>; newRids: string[] }): RevisionEvent | null {
  const { step, prev, next, evidence: ev } = a;
  if (next.length === 0) return null;                                  // policy supplied no ledger this step: nothing to audit, previous ledger carries forward
  const newSet = new Set(a.newRids), warnings: string[] = [], changes: LedgerChange[] = [];
  const before = leaderOf(prev), after = leaderOf(next);
  const prevBy = new Map(prev.map((h) => [h.label, h])), nextBy = new Map(next.map((h) => [h.label, h]));
  const everRejected = new Set(a.history.flat().filter((h) => h.status === "REJECTED").map((h) => h.label));

  for (const h of next) {
    for (const r of [...h.supporting, ...(h.refuted_by ?? [])]) if (!validRefs([r], ev).length) warnings.push(`INVALID_REF:${h.label}:${cap(r, 40)}`);
    const was = prevBy.get(h.label), sup = validRefs(h.supporting, ev), ref = validRefs(h.refuted_by, ev);
    if (!was) changes.push({ label: h.label, kind: "ADDED", to: h.status });
    else {
      if (was.status !== h.status) changes.push({ label: h.label, kind: "STATUS", from: was.status, to: h.status });
      const added = sup.filter((r) => !was.supporting.includes(r)), dropped = was.supporting.filter((r) => !sup.includes(r));
      if (added.length) changes.push({ label: h.label, kind: "SUPPORT_ADDED", evidence: added.slice(0, 12) });
      if (dropped.length) changes.push({ label: h.label, kind: "SUPPORT_DROPPED", evidence: dropped.slice(0, 12) });
    }
    if (h.status === "REJECTED" && (!was || was.status !== "REJECTED") && ref.length === 0) warnings.push(`REJECTION_WITHOUT_REFUTATION:${h.label}`);
    if (h.status === "SUPPORTED" && new Set(sup.map((r) => ev.get(r)!.tool)).size < 2) warnings.push(`SUPPORTED_WITHOUT_INDEPENDENCE:${h.label}`);
    if ((h.status === "LEADING" || h.status === "SUPPORTED" || h.status === "ACTIVE") && everRejected.has(h.label) && (was?.status === "REJECTED" || !was) && !sup.some((r) => newSet.has(r))) warnings.push(`REVIVAL_WITHOUT_NEW_EVIDENCE:${h.label}`);
  }
  for (const h of prev) if (!nextBy.has(h.label)) changes.push({ label: h.label, kind: "REMOVED", from: h.status });

  const changed = (before?.label ?? null) !== (after?.label ?? null);
  const supAfter = after ? validRefs(after.supporting, ev) : [];
  const basis: RevisionEvent["leader_basis"] = !after ? "none" : supAfter.length ? "evidence" : "prior";
  let justified = true;
  if (changed) {
    const newLeaderAnchored = supAfter.some((r) => newSet.has(r));
    const oldRefuted = !!before && validRefs(nextBy.get(before.label)?.refuted_by, ev).some((r) => newSet.has(r)) && nextBy.get(before.label)?.status === "REJECTED";
    const firstPrior = !before && step === 1;                          // alert-text prior before any evidence exists
    justified = newLeaderAnchored || oldRefuted || firstPrior;
    if (!justified) warnings.push(`LEADER_CHANGE_WITHOUT_NEW_EVIDENCE:${before?.label ?? "none"}->${after?.label ?? "none"}`);
  }
  if (!changes.length && !warnings.length) return null;
  return { step, leader_before: before?.label ?? null, leader_after: after?.label ?? null, leader_changed: changed, leader_basis: basis, new_evidence: a.newRids.slice(0, 20), changes: changes.slice(0, 24), justified, warnings: [...new Set(warnings)].slice(0, 24) };
}

/** Consistency between the concluding answer and the ledger the policy reported. */
export function checkFinalAgainstLedger(final: FinalAnswer, ledgers: Hypothesis[][]): string[] {
  if (final.outcome !== "DIAGNOSIS") return [];
  const w: string[] = [];
  const lastNonEmpty = [...ledgers].reverse().find((l) => l.length > 0);
  if (!lastNonEmpty) return [`FINAL_LABEL_NEVER_HYPOTHESISED:${cap(final.label, 40)}`];
  const leader = leaderOf(lastNonEmpty);
  if (!ledgers.flat().some((h) => h.label === final.label)) w.push(`FINAL_LABEL_NEVER_HYPOTHESISED:${cap(final.label, 40)}`);
  else if (!leader || leader.label !== final.label) w.push(`FINAL_LABEL_NOT_LEADER:${cap(final.label, 40)}:${leader?.label ?? "none"}`);
  else if (leader.supporting.length && !leader.supporting.some((r) => final.cited.includes(r))) w.push(`FINAL_CITATIONS_DISJOINT_FROM_LEDGER:${cap(final.label, 40)}`);
  return w;
}
