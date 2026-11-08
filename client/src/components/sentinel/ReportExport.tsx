import { useRef } from "react";
import { Download, FileJson, FileText, Link2, Printer, ShieldCheck, Trash2 } from "lucide-react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import { formatTime, shortHash } from "./format";
import { ToneBadge } from "./StatusBadge";
import type { SentinelView } from "./types";

function save(filename: string, mimeType: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: `${mimeType};charset=utf-8` }));
  const a = document.createElement("a");
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Opens the printable report in a new tab. The document is self-contained, escaped, and carries a CSP that forbids scripts and network access. */
function openPrintable(content: string): boolean {
  const url = URL.createObjectURL(new Blob([content], { type: "text/html;charset=utf-8" }));
  const w = window.open(url, "_blank", "noopener,noreferrer");
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return Boolean(w);
}

export function ReportExport({ workspaceId, view, onDelete, deleting, canDelete }: { workspaceId: number; view: SentinelView; onDelete: () => void; deleting: boolean; canDelete: boolean }) {
  const utils = trpc.useUtils();
  const wantPrint = useRef(false);
  const id = view.investigation.id;
  const exportReport = trpc.sentinel.export.useMutation({
    onSuccess: (r) => {
      void utils.sentinel.audit.invalidate();
      const print = wantPrint.current; wantPrint.current = false;
      if (print) { if (openPrintable(r.content)) toast.success("Opened the printable report"); else { save(r.filename, r.mimeType, r.content); toast.message("Pop-ups are blocked, so the report was downloaded instead"); } return; }
      save(r.filename, r.mimeType, r.content); toast.success(`Saved ${r.filename}`);
    },
    onError: (e) => { wantPrint.current = false; toast.error(`Export failed: ${e.message}`); },
  });
  const audit = trpc.sentinel.audit.useQuery({ workspaceId, investigationId: id });
  const complete = view.integrity.complete && Boolean(view.final);
  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-[var(--line)] bg-white p-4">
        <h4 className="flex items-center gap-2 text-sm font-bold"><Download className="size-4" aria-hidden /> Export report</h4>
        <p className="mt-1 text-sm text-[var(--muted)]">{complete ? "The investigation is complete. The report contains the conclusion, cited evidence, tool activity, the proposed (unexecuted) remediation, verification results and integrity data." : "The investigation has not finished. An export now is marked PARTIAL and contains only what has been recorded so far."}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="outline" disabled={exportReport.isPending} onClick={() => exportReport.mutate({ workspaceId, investigationId: id, format: "markdown" })}><FileText className="size-4" aria-hidden /> Markdown</Button>
          <Button variant="outline" disabled={exportReport.isPending} onClick={() => exportReport.mutate({ workspaceId, investigationId: id, format: "json" })}><FileJson className="size-4" aria-hidden /> JSON</Button>
          <Button variant="outline" disabled={exportReport.isPending} onClick={() => exportReport.mutate({ workspaceId, investigationId: id, format: "html" })}><FileText className="size-4" aria-hidden /> HTML</Button>
          <Button variant="outline" disabled={exportReport.isPending} onClick={() => { wantPrint.current = true; exportReport.mutate({ workspaceId, investigationId: id, format: "html" }); }}><Printer className="size-4" aria-hidden /> Print view</Button>
        </div>
      </section>

      {["COMPLETED", "ABSTAINED", "FAILED", "CANCELLED"].includes(view.investigation.status) && (
        <section className="rounded-2xl border border-[var(--line)] bg-white p-4" aria-labelledby="del">
          <h4 id="del" className="flex items-center gap-2 text-sm font-bold"><Trash2 className="size-4" aria-hidden /> Delete investigation</h4>
          <p className="mt-1 text-sm text-[var(--muted)]">Removes the investigation and its evidence trace from this workspace. The activity audit trail is kept. Only the creator or a workspace owner can do this; export the report first if you need a copy.</p>
          <AlertDialog>
            <AlertDialogTrigger asChild><Button variant="outline" className="mt-3" disabled={deleting || !canDelete} title={canDelete ? undefined : "Only the creator or a workspace owner can delete this investigation"}><Trash2 className="size-4" aria-hidden /> {deleting ? "Deleting…" : "Delete…"}</Button></AlertDialogTrigger>
            <AlertDialogContent className="bg-white">
              <AlertDialogHeader><AlertDialogTitle>Delete this investigation?</AlertDialogTitle><AlertDialogDescription>This permanently removes its evidence and trace. It cannot be undone. The audit trail of who created, cancelled, exported and deleted it is retained.</AlertDialogDescription></AlertDialogHeader>
              <AlertDialogFooter><AlertDialogCancel>Keep it</AlertDialogCancel><AlertDialogAction onClick={onDelete}>Delete permanently</AlertDialogAction></AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </section>
      )}

      <section className="rounded-2xl border border-[var(--line)] bg-white p-4" aria-labelledby="integrity">
        <h4 id="integrity" className="flex items-center gap-2 text-sm font-bold"><ShieldCheck className="size-4" aria-hidden /> Record integrity</h4>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
          <ToneBadge tone={view.integrity.chainOk ? "ok" : "bad"}>{view.integrity.chainOk ? "event chain intact" : "event chain BROKEN"}</ToneBadge>
          <ToneBadge tone={view.integrity.complete ? "ok" : "info"}>{view.integrity.complete ? "trace complete" : "trace incomplete"}</ToneBadge>
          <span className="text-xs text-[var(--muted)]">{view.integrity.eventCount} events</span>
        </div>
        <p className="mt-2 flex items-center gap-1 font-mono text-xs text-[var(--muted)]"><Link2 className="size-3.5" aria-hidden /> head {shortHash(view.integrity.head)}</p>
        {view.integrity.errors.length > 0 && <ul className="mt-2 list-disc pl-5 text-xs text-red-800">{view.integrity.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>}
      </section>

      <section className="rounded-2xl border border-[var(--line)] bg-white p-4" aria-labelledby="audit-log">
        <h4 id="audit-log" className="text-sm font-bold">Activity log</h4>
        {audit.isLoading && <p className="mt-2 text-sm text-[var(--muted)]">Loading…</p>}
        {audit.error && <p role="alert" className="mt-2 text-sm text-red-800">Could not load the activity log: {audit.error.message}</p>}
        {audit.data && audit.data.length === 0 && <p className="mt-2 text-sm text-[var(--muted)]">No activity recorded.</p>}
        <ul className="mt-2 space-y-1 text-sm">{audit.data?.map((a) => <li key={a.id} className="flex flex-wrap gap-x-2"><span className="font-mono text-xs">{a.action}</span><span className="text-[var(--muted)]">user #{a.actorUserId}</span>{a.detail && <span className="text-[var(--muted)]">· {a.detail}</span>}<time className="ml-auto text-xs text-[var(--muted)]">{formatTime(a.createdAt)}</time></li>)}</ul>
        <p className="mt-2 text-xs text-[var(--muted)]">Every diagnostic call is additionally audited by the connector service.</p>
      </section>
    </div>
  );
}
