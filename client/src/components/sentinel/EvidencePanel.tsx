import { useMemo, useState } from "react";
import { Quote, ShieldAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { Empty } from "./ToolActivity";
import { ToneBadge } from "./StatusBadge";
import { evidenceAnchor, type Tone } from "./format";
import type { EvidenceItem } from "./types";

const LEVEL_TONE: Record<string, Tone> = { ERROR: "bad", ERR: "bad", CRITICAL: "bad", FATAL: "bad", WARN: "warn", WARNING: "warn", NOTE: "info", INFO: "info", DEBUG: "info", TRACE: "info" };
type F = "all" | "cited" | "quarantined";

export function EvidencePanel({ evidence, highlight }: { evidence: EvidenceItem[]; highlight?: string }) {
  const [filter, setFilter] = useState<F>("all");
  const [tool, setTool] = useState("all");
  const tools = useMemo(() => [...new Set(evidence.map((e) => e.tool))], [evidence]);
  const shown = evidence.filter((e) => (filter === "all" || (filter === "cited" ? e.cited : e.quarantined)) && (tool === "all" || e.tool === tool));
  if (!evidence.length) return <Empty text="No evidence has been collected yet. Records appear here as diagnostic tools return data." />;
  const counts = { cited: evidence.filter((e) => e.cited).length, quarantined: evidence.filter((e) => e.quarantined).length };
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2" role="group" aria-label="Evidence filters">
        {(["all", "cited", "quarantined"] as F[]).map((f) => (
          <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)} className={cn("rounded-full border px-3 py-1 text-xs font-medium", filter === f ? "border-[var(--deep)] bg-[var(--deep)] text-white" : "border-[var(--line)] bg-white text-[var(--muted)] hover:bg-slate-50")}>
            {f === "all" ? `All (${evidence.length})` : f === "cited" ? `Cited by conclusion (${counts.cited})` : `Quarantined (${counts.quarantined})`}
          </button>
        ))}
        <label className="ml-auto flex items-center gap-2 text-xs text-[var(--muted)]">Tool
          <select value={tool} onChange={(e) => setTool(e.target.value)} className="rounded-md border border-[var(--line)] bg-white px-2 py-1 text-xs text-[var(--ink)]">
            <option value="all">All tools</option>{tools.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
      </div>
      {shown.length === 0 && <Empty text="No evidence matches these filters." />}
      <ul className="space-y-2">
        {shown.map((e) => (
          <li key={e.rid} id={evidenceAnchor(e.rid)} className={cn("scroll-mt-24 rounded-xl border bg-white p-3", e.cited ? "border-[var(--deep)]" : "border-[var(--line)]", highlight === e.rid && "ring-2 ring-lime-400")}>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="font-mono font-semibold">{e.rid}</span>
              {e.cited && <ToneBadge tone="ok"><Quote aria-hidden /> Cited</ToneBadge>}
              {e.quarantined && <ToneBadge tone="bad"><ShieldAlert aria-hidden /> Quarantined</ToneBadge>}
              <ToneBadge tone={LEVEL_TONE[e.level] ?? "info"}>{e.level}</ToneBadge>
              <span className="text-[var(--muted)]"><span className="font-mono">{e.tool}</span> on <span className="font-mono">{e.target}</span> · step {e.step}</span>
              <time className="ml-auto text-[var(--muted)]" dateTime={e.ts}>{e.ts}</time>
            </div>
            <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-[13px] leading-relaxed text-[var(--ink)]">{e.text}</pre>
          </li>
        ))}
      </ul>
    </div>
  );
}
