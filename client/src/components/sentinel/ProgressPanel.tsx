import { Activity, Ban, RotateCcw, ShieldAlert } from "lucide-react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { TONE_CLASS, formatTime, modelIdentityText, statusMeta } from "./format";
import type { SentinelView } from "./types";

const PHASE_TEXT: Record<string, string> = {
  queued: "Waiting for a worker to pick this investigation up.",
  deciding: "The model is deciding the next diagnostic step.",
  calling: "Running a read-only diagnostic tool.",
  finished: "Investigation finished.",
};

export function ProgressPanel({ view, onCancel, cancelling, canCancel }: { view: SentinelView; onCancel: () => void; cancelling: boolean; canCancel: boolean }) {
  const { investigation: inv, progress: p, task } = view;
  const meta = statusMeta(inv.status);
  const live = view.toolCalls.find((t) => t.status === "PENDING");
  const mi = modelIdentityText(view.modelIdentity, inv.status !== "QUEUED");
  const cancelRequested = Boolean(task?.cancelRequested) && !meta.terminal;
  const retrying = !meta.terminal && task?.state === "WAITING";
  return (
    <section aria-labelledby="sentinel-progress" className="rounded-2xl border border-[var(--line)] bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 id="sentinel-progress" className="flex items-center gap-2 text-sm font-bold"><Activity className="size-4 text-[var(--deep)]" aria-hidden /> Progress</h3>
        {!meta.terminal && (
          <AlertDialog>
            <AlertDialogTrigger asChild><Button variant="outline" size="sm" disabled={cancelling || cancelRequested || !canCancel} title={canCancel ? undefined : "Only the creator or a workspace owner can cancel this investigation"}><Ban className="size-4" aria-hidden /> {cancelRequested ? "Cancelling…" : "Cancel"}</Button></AlertDialogTrigger>
            <AlertDialogContent className="bg-white">
              <AlertDialogHeader><AlertDialogTitle>Cancel this investigation?</AlertDialogTitle><AlertDialogDescription>The run stops at its next safe point. Evidence collected so far stays in the record. Nothing on your systems is changed by Sentinel in either case.</AlertDialogDescription></AlertDialogHeader>
              <AlertDialogFooter><AlertDialogCancel>Keep running</AlertDialogCancel><AlertDialogAction onClick={onCancel}>Cancel investigation</AlertDialogAction></AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </div>
      <div className="mt-3" role="status" aria-live="polite">
        <p className="text-sm text-[var(--ink)]">{retrying ? "The last attempt hit a problem (for example the model provider was unavailable). It is waiting to retry automatically; evidence gathered so far is kept." : PHASE_TEXT[p.phase]}{live ? <> <span className="font-mono text-xs">{live.tool}</span> on <span className="font-mono text-xs">{live.target}</span>…</> : null}</p>
        {inv.errorMessage && <p className="mt-1 flex items-start gap-1 text-sm text-red-800"><ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden /> {inv.errorMessage}</p>}
        {cancelRequested && <p className="mt-1 text-sm text-amber-800">Cancellation requested; stopping at the next safe point.</p>}
      </div>
      <Progress className="mt-3 bg-slate-100" value={p.percent} aria-label="Investigation progress" />
      <dl className="mt-3 grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
        <div><dt className="text-[var(--muted)]">Steps</dt><dd className="font-mono text-sm font-semibold">{p.step} / {p.maxSteps}</dd></div>
        <div><dt className="text-[var(--muted)]">Tool calls</dt><dd className="font-mono text-sm font-semibold">{p.callsUsed} / {p.maxCalls}</dd></div>
        <div><dt className="text-[var(--muted)]">Started</dt><dd className="text-sm">{formatTime(inv.startedAt)}</dd></div>
        <div><dt className="text-[var(--muted)]">Finished</dt><dd className="text-sm">{formatTime(inv.finishedAt)}</dd></div>
        <div className="col-span-2 sm:col-span-4"><dt className="text-[var(--muted)]">Model (reported by the gateway)</dt><dd className="text-sm" title={mi.detail}><span className={`rounded-md border px-1.5 py-0.5 text-xs font-semibold ${TONE_CLASS[mi.tone]}`}>{mi.text}</span></dd></div>
      </dl>
      {(p.resumes > 0 || (task && task.attempt > 1)) && (
        <p className="mt-3 flex items-center gap-1 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900"><RotateCcw className="size-3.5" aria-hidden /> Resumed {p.resumes} time(s) after interruption{task ? ` · worker attempt ${task.attempt}/${task.maxAttempts}` : ""}. Completed tool calls were not repeated.</p>
      )}
    </section>
  );
}
