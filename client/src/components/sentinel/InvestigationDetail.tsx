import { useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { toast } from "sonner";
import { Server, Target } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { trpc } from "@/lib/trpc";
import { ConclusionPanel } from "./ConclusionPanel";
import { EvidencePanel } from "./EvidencePanel";
import { HypothesesPanel } from "./HypothesesPanel";
import { ProgressPanel } from "./ProgressPanel";
import { ReportExport } from "./ReportExport";
import { SeverityBadge, StatusBadge } from "./StatusBadge";
import { Timeline } from "./Timeline";
import { ToolActivity } from "./ToolActivity";
import { evidenceAnchor, formatTime } from "./format";
import { useInvestigation } from "./useSentinel";

export function InvestigationDetail({ workspaceId, investigationId, viewer, onDeleted }: { workspaceId: number; investigationId: string; viewer: { userId: number; isOwner: boolean } | null; onDeleted: () => void }) {
  const utils = trpc.useUtils();
  const reduce = useReducedMotion();
  const { progress, view } = useInvestigation(workspaceId, investigationId);
  const [tab, setTab] = useState("conclusion");
  const [highlight, setHighlight] = useState<string | undefined>(undefined);
  const status = progress.data?.status;
  const lastStatus = useRef<string | undefined>(undefined);
  useEffect(() => { if (status && lastStatus.current && lastStatus.current !== status) void utils.sentinel.list.invalidate(); lastStatus.current = status; }, [status, utils]);
  useEffect(() => { setTab("conclusion"); setHighlight(undefined); }, [investigationId]);

  const cancel = trpc.sentinel.cancel.useMutation({
    onSuccess: (r) => { toast.message(r.status === "CANCELLED" ? "Investigation cancelled" : "Cancellation requested"); void utils.sentinel.progress.invalidate(); void utils.sentinel.get.invalidate(); void utils.sentinel.list.invalidate(); },
    onError: (e) => toast.error(`Could not cancel: ${e.message}`),
  });

  const del = trpc.sentinel.delete.useMutation({
    onSuccess: () => { toast.success("Investigation deleted. Its audit trail is retained."); void utils.sentinel.list.invalidate(); onDeleted(); },
    onError: (e) => toast.error(`Could not delete: ${e.message}`),
  });
  const jump = (rid: string) => {
    setTab("evidence"); setHighlight(rid);
    setTimeout(() => document.getElementById(evidenceAnchor(rid))?.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" }), 60);
  };

  if (view.isLoading) return <div className="space-y-3" aria-busy="true"><Skeleton className="h-24 w-full rounded-2xl" /><Skeleton className="h-32 w-full rounded-2xl" /><Skeleton className="h-64 w-full rounded-2xl" /></div>;
  if (view.error) return <div role="alert" className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">Could not load this investigation: {view.error.message} <button className="ml-1 underline" onClick={() => void view.refetch()}>Retry</button></div>;
  const v = view.data;
  if (!v) return null;
  const inv = v.investigation;
  // Cancel/delete are creator-or-owner on the server. Unknown viewer (status not loaded) leaves the buttons enabled; the server still decides.
  const canModify = !viewer || viewer.isOwner || viewer.userId === inv.createdByUserId;
  return (
    <motion.div initial={reduce ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }} className="space-y-4">
      <header className="rounded-2xl border border-[var(--line)] bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center gap-2"><StatusBadge status={inv.status} /><SeverityBadge severity={inv.severity} /><span className="text-xs text-[var(--muted)]">Investigation <span className="font-mono">{inv.id.slice(0, 8)}</span> · created {formatTime(inv.createdAt)}</span></div>
        <h2 className="mt-2 text-xl font-extrabold leading-tight text-[var(--ink)]">{inv.title}</h2>
        <p className="mt-1 whitespace-pre-wrap text-sm text-[var(--muted)]">{inv.description}</p>
        <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
          <div><dt className="flex items-center gap-1 text-xs text-[var(--muted)]"><Target className="size-3.5" aria-hidden /> Objective</dt><dd>{inv.objective}</dd></div>
          <div><dt className="flex items-center gap-1 text-xs text-[var(--muted)]"><Server className="size-3.5" aria-hidden /> Scope (read-only)</dt>
            <dd className="font-mono text-xs">{[...inv.inventory.services, ...inv.inventory.hosts].join(", ")}<br /><span className="font-sans text-[var(--muted)]">tools: {inv.allowedTools.join(", ")} · alert fired {formatTime(inv.firedAt)}</span></dd></div>
        </dl>
        {inv.operatorNotes.length > 0 && <ul className="mt-2 list-disc pl-5 text-xs text-[var(--muted)]">{inv.operatorNotes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
      </header>

      <ProgressPanel view={v} canCancel={canModify} cancelling={cancel.isPending} onCancel={() => cancel.mutate({ workspaceId, investigationId })} />

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex h-auto w-full flex-wrap justify-start gap-1 bg-white/70 p-1">
          <TabsTrigger value="conclusion">Conclusion</TabsTrigger>
          <TabsTrigger value="evidence">Evidence ({v.evidence.length})</TabsTrigger>
          <TabsTrigger value="hypotheses">Hypotheses</TabsTrigger>
          <TabsTrigger value="tools">Tool activity ({v.toolCalls.length})</TabsTrigger>
          <TabsTrigger value="timeline">Timeline</TabsTrigger>
          <TabsTrigger value="report">Report</TabsTrigger>
        </TabsList>
        <div className="mt-3">
          <TabsContent value="conclusion"><ConclusionPanel view={v} onJump={jump} /></TabsContent>
          <TabsContent value="evidence"><EvidencePanel evidence={v.evidence} highlight={highlight} /></TabsContent>
          <TabsContent value="hypotheses"><HypothesesPanel hypotheses={v.hypotheses} onJump={jump} /></TabsContent>
          <TabsContent value="tools"><ToolActivity calls={v.toolCalls} onJump={jump} /></TabsContent>
          <TabsContent value="timeline"><Timeline items={v.timeline} /></TabsContent>
          <TabsContent value="report"><ReportExport workspaceId={workspaceId} view={v} canDelete={canModify} deleting={del.isPending} onDelete={() => del.mutate({ workspaceId, investigationId })} /></TabsContent>
        </div>
      </Tabs>
    </motion.div>
  );
}
