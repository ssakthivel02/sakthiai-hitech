import { cn } from "@/lib/utils";
import { Empty } from "./ToolActivity";
import type { SentinelView } from "./types";

const DOT: Record<string, string> = { ok: "bg-emerald-500", warn: "bg-amber-500", bad: "bg-red-500", info: "bg-slate-400" };

export function Timeline({ items }: { items: SentinelView["timeline"] }) {
  if (!items.length) return <Empty text="No events recorded yet." />;
  return (
    <ol className="relative space-y-3 border-l border-[var(--line)] pl-5" aria-label="Investigation timeline">
      {items.map((t) => (
        <li key={t.seq} className="relative">
          <span aria-hidden className={cn("absolute -left-[26px] top-1.5 size-2.5 rounded-full ring-4 ring-[#f5f7f2]", DOT[t.tone] ?? DOT.info)} />
          <div className="flex flex-wrap items-baseline gap-x-2 text-sm"><span className="font-semibold">{t.label}</span>{t.step !== null && <span className="text-xs text-[var(--muted)]">step {t.step}</span>}<span className="ml-auto font-mono text-[11px] text-[var(--muted)]">#{t.seq}</span></div>
          {t.detail && <p className="text-xs text-[var(--muted)]">{t.detail}</p>}
        </li>
      ))}
    </ol>
  );
}
