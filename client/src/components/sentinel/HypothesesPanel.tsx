import { GitCompareArrows } from "lucide-react";
import { Empty } from "./ToolActivity";
import { ToneBadge } from "./StatusBadge";
import { humanLabel, type Tone } from "./format";
import type { SentinelView } from "./types";

const STATUS_TONE: Record<string, Tone> = { LEADING: "live", SUPPORTED: "ok", ACTIVE: "info", REJECTED: "bad" };

export function HypothesesPanel({ hypotheses, onJump }: { hypotheses: SentinelView["hypotheses"]; onJump: (rid: string) => void }) {
  if (!hypotheses.latest.length && !hypotheses.history.length) return <Empty text="No hypotheses have been recorded yet. They appear as the model reports its working theories after each step." />;
  const sorted = [...hypotheses.latest].sort((a, b) => b.score - a.score);
  return (
    <div className="space-y-5">
      <section aria-labelledby="hyp-latest">
        <h4 id="hyp-latest" className="mb-2 text-sm font-bold">Current hypotheses</h4>
        {sorted.length === 0 && <p className="text-sm text-[var(--muted)]">The last step reported no hypotheses.</p>}
        <ul className="space-y-2">
          {sorted.map((h) => (
            <li key={h.label} className="rounded-xl border border-[var(--line)] bg-white p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold">{humanLabel(h.label)}</span>
                <ToneBadge tone={STATUS_TONE[h.status] ?? "info"}>{h.status.toLowerCase()}</ToneBadge>
                <span className="ml-auto font-mono text-xs text-[var(--muted)]">model score {h.score.toFixed(2)}</span>
              </div>
              <div role="meter" aria-valuemin={0} aria-valuemax={1} aria-valuenow={h.score} aria-label={`${humanLabel(h.label)} score`} className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100">
                <div className="h-full rounded-full bg-[var(--deep)]" style={{ width: `${Math.round(h.score * 100)}%` }} />
              </div>
              {(h.supporting.length > 0 || (h.refuted_by?.length ?? 0) > 0) && (
                <div className="mt-2 flex flex-wrap items-center gap-1 text-xs">
                  {h.supporting.length > 0 && <span className="text-[var(--muted)]">Supported by</span>}
                  {h.supporting.map((r) => <button key={r} type="button" onClick={() => onJump(r)} className="rounded-md border border-[var(--line)] px-1.5 py-0.5 font-mono text-[11px] hover:bg-lime-50">{r}</button>)}
                  {(h.refuted_by?.length ?? 0) > 0 && <span className="ml-2 text-[var(--muted)]">Refuted by</span>}
                  {h.refuted_by?.map((r) => <button key={r} type="button" onClick={() => onJump(r)} className="rounded-md border border-red-200 px-1.5 py-0.5 font-mono text-[11px] hover:bg-red-50">{r}</button>)}
                </div>
              )}
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-[var(--muted)]">Scores are the model's own estimates, not calibrated probabilities.</p>
      </section>

      <section aria-labelledby="hyp-rev">
        <h4 id="hyp-rev" className="mb-2 flex items-center gap-2 text-sm font-bold"><GitCompareArrows className="size-4" aria-hidden /> Revision audit</h4>
        {hypotheses.revisions.length === 0 ? <p className="text-sm text-[var(--muted)]">No revisions recorded.</p> : (
          <ol className="space-y-2">
            {hypotheses.revisions.map((r, i) => (
              <li key={i} className="rounded-xl border border-[var(--line)] bg-white p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">Step {r.step}</span>
                  {r.leader_changed ? <span>Leader: <b>{r.leader_before ? humanLabel(r.leader_before) : "none"}</b> → <b>{r.leader_after ? humanLabel(r.leader_after) : "none"}</b></span> : <span className="text-[var(--muted)]">Leader unchanged</span>}
                  {r.leader_changed && (r.leader_before === null
                    ? <ToneBadge tone="info">initial hypothesis</ToneBadge>
                    : <ToneBadge tone={r.justified ? "ok" : "warn"}>{r.justified ? "justified by new evidence" : "no new evidence cited"}</ToneBadge>)}
                </div>
                {r.changes.length > 0 && <ul className="mt-1 list-disc pl-5 text-xs text-[var(--muted)]">{r.changes.slice(0, 8).map((c, j) => <li key={j}>{humanLabel(c.label)}: {c.kind.toLowerCase().replace(/_/g, " ")}{c.from && c.to ? ` (${c.from} → ${c.to})` : ""}</li>)}</ul>}
                {r.warnings.length > 0 && <p className="mt-1 text-xs text-amber-800">Warnings: {r.warnings.join("; ")}</p>}
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
