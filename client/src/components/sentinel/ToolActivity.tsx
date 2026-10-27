import { ChevronDown, Wrench } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { ToneBadge } from "./StatusBadge";
import { formatDuration, type Tone } from "./format";
import type { ToolCall } from "./types";

const CALL_TONE: Record<string, Tone> = { OK: "ok", NO_DATA: "info", PENDING: "live", TIMEOUT: "warn", ERROR: "bad", DENIED: "bad" };
const CALL_LABEL: Record<string, string> = { OK: "Returned data", NO_DATA: "No data", PENDING: "Running", TIMEOUT: "Timed out", ERROR: "Error", DENIED: "Denied" };
const DENY_TEXT: Record<string, string> = {
  WRITE_TOOLS_DISABLED: "Write tools are permanently disabled in Sentinel.",
  TOOL_NOT_ALLOWED: "This tool is not enabled for this investigation.",
  OUT_OF_SCOPE: "The target is not in this investigation's inventory.",
  BUDGET_EXHAUSTED: "The tool-call budget was exhausted.",
  TIME_EXHAUSTED: "The time budget was exhausted.",
};

export function ToolActivity({ calls, onJump }: { calls: ToolCall[]; onJump: (rid: string) => void }) {
  const [open, setOpen] = useState<number | null>(null);
  if (!calls.length) return <Empty text="No diagnostic tool has been called yet." />;
  return (
    <ol className="space-y-2" aria-label="Diagnostic tool calls">
      {calls.map((c) => {
        const isOpen = open === c.index;
        const deny = c.denyReason ? DENY_TEXT[c.denyReason.split(":")[0]!] ?? c.denyReason : null;
        return (
          <li key={c.index} className="rounded-xl border border-[var(--line)] bg-white">
            <button type="button" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : c.index)} className="flex w-full items-center gap-3 rounded-xl p-3 text-left hover:bg-slate-50 motion-reduce:transition-none">
              <Wrench className="size-4 shrink-0 text-[var(--deep)]" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold"><span className="font-mono">{c.tool}</span> <span className="text-[var(--muted)]">on</span> <span className="font-mono">{c.target}</span></span>
                <span className="block text-xs text-[var(--muted)]">Step {c.step} · {c.status === "PENDING" ? "in progress" : formatDuration(c.durationMs)} · {c.recordCount} record(s){c.quarantinedCount ? ` · ${c.quarantinedCount} quarantined` : ""}{c.replayed ? " · replayed" : ""}</span>
              </span>
              <ToneBadge tone={CALL_TONE[c.status] ?? "info"}>{CALL_LABEL[c.status] ?? c.status}</ToneBadge>
              <ChevronDown className={cn("size-4 transition-transform motion-reduce:transition-none", isOpen && "rotate-180")} aria-hidden />
            </button>
            {isOpen && (
              <div className="space-y-2 border-t border-[var(--line)] p-3 text-sm">
                {deny && <p className="text-red-800">{deny}</p>}
                {c.error && <p className="text-red-800">Adapter error code: <span className="font-mono">{c.error}</span></p>}
                {c.sourceSystem && <p className="text-[var(--muted)]">Source: <span className="font-mono">{c.sourceSystem}</span> · attempts: {c.attempts}</p>}
                {c.args && <p className="text-[var(--muted)]">Arguments: <span className="font-mono">{JSON.stringify(c.args)}</span></p>}
                {c.rids.length > 0 && (
                  <div className="flex flex-wrap gap-1" aria-label="Evidence records from this call">
                    {c.rids.slice(0, 40).map((r) => <button key={r} type="button" onClick={() => onJump(r)} className="rounded-md border border-[var(--line)] px-1.5 py-0.5 font-mono text-[11px] hover:bg-lime-50">{r}</button>)}
                    {c.rids.length > 40 && <span className="text-xs text-[var(--muted)]">+{c.rids.length - 40} more</span>}
                  </div>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

export function Empty({ text }: { text: string }) {
  return <p className="rounded-xl border border-dashed border-[var(--line)] bg-white p-5 text-sm text-[var(--muted)]">{text}</p>;
}
