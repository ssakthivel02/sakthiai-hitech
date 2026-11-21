import { BadgeCheck, FileWarning, Lightbulb, ShieldCheck, Wrench } from "lucide-react";
import { Empty } from "./ToolActivity";
import { ToneBadge } from "./StatusBadge";
import { confidencePct, humanLabel, statusMeta } from "./format";
import type { SentinelView } from "./types";

export function ConclusionPanel({ view, onJump }: { view: SentinelView; onJump: (rid: string) => void }) {
  const { final, verification, investigation: inv } = view;
  if (!final) {
    const terminal = statusMeta(inv.status).terminal;
    return <Empty text={terminal ? `This investigation ended without a recorded conclusion${inv.errorMessage ? `: ${inv.errorMessage}` : "."}` : "No conclusion yet. Sentinel is still collecting evidence; a conclusion is only shown once it has been independently checked."} />;
  }
  const diagnosis = final.outcome === "DIAGNOSIS";
  return (
    <div className="space-y-4">
      <section aria-labelledby="concl" className={`rounded-2xl border p-4 ${diagnosis ? "border-emerald-200 bg-emerald-50/60" : "border-amber-200 bg-amber-50/60"}`}>
        <div className="flex flex-wrap items-center gap-2">
          <h4 id="concl" className="text-base font-bold">{diagnosis ? `Most likely cause: ${humanLabel(final.label)}` : "No conclusion drawn"}</h4>
          <ToneBadge tone={diagnosis ? "ok" : "warn"}>{diagnosis ? "diagnosis" : "abstained"}</ToneBadge>
          <span className="ml-auto text-xs text-[var(--muted)]" title="The model's own confidence figure. It has not been calibrated against outcomes.">confidence {confidencePct(final.confidence)} · model-stated</span>
        </div>
        <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed">{final.summary}</p>
        {final.abstainReason && <p className="mt-2 text-xs text-[var(--muted)]">Reason: <span className="font-mono">{final.abstainReason}</span></p>}
      </section>

      {final.citations.length > 0 && (
        <section aria-labelledby="cites">
          <h4 id="cites" className="mb-2 text-sm font-bold">Cited evidence ({final.citations.length})</h4>
          <ul className="space-y-2">
            {final.citations.map((c) => (
              <li key={c.rid} className="rounded-xl border border-[var(--line)] bg-white p-3">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <button type="button" onClick={() => onJump(c.rid)} className="rounded-md border border-[var(--line)] px-1.5 py-0.5 font-mono font-semibold hover:bg-lime-50">{c.rid}</button>
                  <span className="text-[var(--muted)]"><span className="font-mono">{c.tool}</span> on <span className="font-mono">{c.target}</span> · {c.ts}</span>
                </div>
                <pre className="mt-1.5 whitespace-pre-wrap break-words font-mono text-[13px]">{c.text}</pre>
              </li>
            ))}
          </ul>
          {final.contradictions.length > 0 && <p className="mt-2 text-xs text-amber-900">Contradicting pairs: {final.contradictions.map(([a, b]) => `${a?.rid ?? "?"} ↔ ${b?.rid ?? "?"}`).join("; ")}</p>}
        </section>
      )}

      <section aria-labelledby="remed" className="rounded-2xl border-2 border-dashed border-[var(--deep)] bg-white p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h4 id="remed" className="flex items-center gap-2 text-sm font-bold"><Wrench className="size-4" aria-hidden /> Proposed remediation</h4>
          <ToneBadge tone="warn"><FileWarning aria-hidden /> Proposal only · not executed · needs human approval</ToneBadge>
        </div>
        <p className="mt-2 whitespace-pre-wrap text-sm">{final.remediation.text}</p>
        <p className="mt-2 text-xs text-[var(--muted)]">Sentinel is read-only and has no ability to change your systems. Apply this only through your normal change process.</p>
      </section>

      {final.nextSafeSteps.length > 0 && (
        <section aria-labelledby="next">
          <h4 id="next" className="mb-2 flex items-center gap-2 text-sm font-bold"><Lightbulb className="size-4" aria-hidden /> Next safe steps</h4>
          <ul className="list-disc space-y-1 pl-5 text-sm">{final.nextSafeSteps.map((s, i) => <li key={i}>{s}</li>)}</ul>
        </section>
      )}

      {verification && (
        <section aria-labelledby="verif" className="rounded-2xl border border-[var(--line)] bg-white p-4">
          <h4 id="verif" className="flex items-center gap-2 text-sm font-bold">{verification.passed ? <BadgeCheck className="size-4 text-emerald-700" aria-hidden /> : <ShieldCheck className="size-4 text-red-700" aria-hidden />} Independent evidence checks: {verification.passed ? "passed" : "failed"}</h4>
          <p className="mt-1 text-xs text-[var(--muted)]">{verification.note}</p>
          {verification.rejectedChecks.length > 0 && <p className="mt-2 text-xs text-red-800">Rejected: {verification.rejectedChecks.slice(0, 6).join("; ")}</p>}
          {verification.ledgerWarnings.length > 0 && <p className="mt-1 text-xs text-amber-800">Ledger warnings: {verification.ledgerWarnings.join("; ")}</p>}
          {verification.redactions.length > 0 && <p className="mt-1 text-xs text-amber-800">{verification.redactions.length} unverifiable name(s) or instruction-like phrase(s) were redacted from the text above.</p>}
        </section>
      )}
    </div>
  );
}
