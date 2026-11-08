import { useMemo, useState } from "react";
import { Link, useLocation, useRoute } from "wouter";
import { ArrowLeft, Lock, Plug, Plus, Radar, ShieldCheck } from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { startLogin } from "@/const";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ConnectorsPanel } from "@/components/sentinel/ConnectorsPanel";
import { InvestigationDetail } from "@/components/sentinel/InvestigationDetail";
import { InvestigationList } from "@/components/sentinel/InvestigationList";
import { NewInvestigationDialog } from "@/components/sentinel/NewInvestigationDialog";
import { ModelRuntimePanel } from "@/components/sentinel/ModelRuntimePanel";
import { RuntimeStatus } from "@/components/sentinel/RuntimeStatus";
import { ToneBadge } from "@/components/sentinel/StatusBadge";
import { modelStatus } from "@/components/sentinel/format";
import { useHistory } from "@/components/sentinel/useSentinel";

/**
 * SakthiAI Sentinel: read-only incident investigation. Every value on this page comes from the workspace-scoped sentinel.* API
 * (persisted, hash-chained investigation records). When the feature is off, or nothing exists yet, the page says so; it never shows sample data.
 */
export default function Sentinel() {
  const { isAuthenticated, loading } = useAuth();
  const [, navigate] = useLocation();
  const [onConnectors] = useRoute("/sentinel/connectors");
  const [, params] = useRoute("/sentinel/:id");
  const selectedId = onConnectors ? undefined : params?.id;
  const [creating, setCreating] = useState(false);
  const [statusFilter, setStatusFilter] = useState("");

  const workspaces = trpc.workspace.list.useQuery(undefined, { enabled: isAuthenticated });
  const workspaceId = workspaces.data?.[0]?.workspace.id;
  const info = trpc.sentinel.status.useQuery({ workspaceId: workspaceId! }, { enabled: Boolean(workspaceId) });
  const active = Boolean(workspaceId && info.data?.enabled);
  const history = useHistory(workspaceId, statusFilter || undefined, active && !onConnectors);
  const catalog = trpc.sentinel.connectorCatalog.useQuery({ workspaceId: workspaceId! }, { enabled: active });
  const items = useMemo(() => history.data?.pages.flatMap((p) => p.items), [history.data]);
  const connectorSummary = useMemo(() => {
    const list = catalog.data?.connectors;
    return list ? { total: list.length, enabled: list.filter((c) => c.enabled).length, syntheticEnabled: list.filter((c) => c.enabled && c.synthetic).length } : undefined;
  }, [catalog.data]);

  if (loading) return <div className="loading-screen">Loading Sentinel…</div>;
  if (!isAuthenticated) {
    return (
      <main className="mx-auto flex min-h-screen max-w-xl flex-col items-start justify-center gap-4 p-6">
        <div className="eyebrow">SAKTHIAI · SENTINEL</div>
        <h1 className="text-2xl font-extrabold">Sign in to investigate incidents in your workspace.</h1>
        <Button onClick={() => startLogin()}>Sign in</Button>
        <Link href="/" className="text-sm underline">Return home</Link>
      </main>
    );
  }

  const model = modelStatus(info.data?.model);
  const canCreate = active && info.data?.workerEnabled && !model.blocksStart;
  const whyNot = !active ? "" : !info.data?.workerEnabled ? "The background task worker is off." : model.blocksStart ? model.detail : "";
  const tab = (href: string, label: string, current: boolean, Icon: typeof Radar) => (
    <Link href={href} aria-current={current ? "page" : undefined} className={cn("inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--deep)]/40", current ? "border-[var(--deep)] bg-[var(--deep)] text-white" : "border-[var(--line)] bg-white text-[var(--ink)] hover:bg-slate-50")}><Icon className="size-4" aria-hidden /> {label}</Link>
  );
  return (
    <main className="min-h-screen bg-[#f5f7f2] text-[var(--ink)]">
      <div className="mx-auto max-w-[1280px] px-4 py-6 sm:px-6">
        <header className="mb-5 flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <Link href="/" className="mb-2 inline-flex items-center gap-1 text-sm text-[var(--muted)] hover:underline"><ArrowLeft className="size-4" aria-hidden /> Workspace</Link>
            <div className="eyebrow">SAKTHIAI · SENTINEL</div>
            <h1 className="flex items-center gap-2 text-2xl font-extrabold tracking-tight sm:text-3xl"><Radar className="size-7 text-[var(--deep)]" aria-hidden /> Incident investigations</h1>
            <p className="mt-1 max-w-2xl text-sm text-[var(--muted)]">Evidence-first root-cause analysis. Sentinel reads from your diagnostic systems, shows its working, and proposes fixes it never applies.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <ToneBadge tone="ok"><ShieldCheck aria-hidden /> Read-only</ToneBadge>
            <Button disabled={!canCreate} onClick={() => setCreating(true)} title={whyNot || undefined} className="bg-[var(--deep)] text-white hover:bg-[var(--deep)]/90"><Plus className="size-4" aria-hidden /> New investigation</Button>
          </div>
        </header>
        {whyNot && <p role="status" className="-mt-2 mb-4 text-right text-xs text-amber-800">New investigations are unavailable: {whyNot}</p>}

        {(workspaces.isLoading || (Boolean(workspaceId) && info.isLoading)) && <div className="space-y-3" aria-busy="true"><Skeleton className="h-24 w-full rounded-2xl" /><Skeleton className="h-64 w-full rounded-2xl" /></div>}
        {workspaces.error && <div role="alert" className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">Could not load your workspace: {workspaces.error.message}</div>}
        {!workspaces.isLoading && !workspaces.error && !workspaceId && <p className="rounded-2xl border border-dashed border-[var(--line)] bg-white p-6 text-sm">No workspace is available yet. Open the <Link href="/" className="underline">workspace home</Link> once to create it.</p>}
        {info.error && <div role="alert" className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">Could not read Sentinel status: {info.error.message}</div>}

        {info.data && !info.data.enabled && (
          <section className="rounded-2xl border border-[var(--line)] bg-white p-8 text-center shadow-sm" aria-labelledby="sn-off">
            <Lock className="mx-auto size-8 text-[var(--muted)]" aria-hidden />
            <h2 id="sn-off" className="mt-3 text-lg font-bold">Sentinel is turned off for this deployment</h2>
            <p className="mx-auto mt-2 max-w-xl text-sm text-[var(--muted)]">Investigations are disabled by default. An administrator enables them with the <code className="rounded bg-slate-100 px-1">SENTINEL_ENABLED</code> setting together with the background task worker. No investigation data exists or is shown while the feature is off.</p>
          </section>
        )}

        {info.data?.enabled && workspaceId && (
          <>
            <RuntimeStatus enabled workerEnabled={info.data.workerEnabled} model={info.data.model} connectors={connectorSummary} />
            <ModelRuntimePanel workspaceId={workspaceId} />
            <nav aria-label="Sentinel sections" className="mb-4 flex flex-wrap gap-2">
              {tab("/sentinel", "Investigations", !onConnectors, Radar)}
              {tab("/sentinel/connectors", "Connectors", Boolean(onConnectors), Plug)}
            </nav>
            {onConnectors ? <ConnectorsPanel workspaceId={workspaceId} /> : (
              <div className="grid gap-6 lg:grid-cols-[minmax(280px,340px)_minmax(0,1fr)]">
                <aside className="min-w-0 lg:sticky lg:top-4 lg:self-start">
                  <InvestigationList items={items} loading={history.isLoading} error={history.error?.message} selectedId={selectedId} onRetry={() => void history.refetch()}
                    status={statusFilter} onStatus={setStatusFilter} hasMore={Boolean(history.hasNextPage)} loadingMore={history.isFetchingNextPage} onLoadMore={() => void history.fetchNextPage()} />
                </aside>
                <div className="min-w-0">
                  {selectedId
                    ? <InvestigationDetail key={selectedId} workspaceId={workspaceId} investigationId={selectedId} viewer={info.data?.viewer ?? null} onDeleted={() => navigate("/sentinel")} />
                    : (
                      <section className="rounded-2xl border border-dashed border-[var(--line)] bg-white p-10 text-center">
                        <Radar className="mx-auto size-9 text-[var(--deep)]" aria-hidden />
                        <h2 className="mt-3 text-lg font-bold">{items?.length ? "Select an investigation" : "Start your first investigation"}</h2>
                        <p className="mx-auto mt-1 max-w-md text-sm text-[var(--muted)]">{items?.length ? "Choose one from the history to see its progress, evidence, hypotheses and report." : "Describe an alert and pick the read-only tools Sentinel may use. Everything you see afterwards is a record of what actually happened."}</p>
                        {canCreate && <Button className="mt-4" onClick={() => setCreating(true)}><Plus className="size-4" aria-hidden /> New investigation</Button>}
                        {active && connectorSummary && connectorSummary.enabled === 0 && <p className="mx-auto mt-3 max-w-md text-xs text-amber-800">No connector is enabled yet. <Link href="/sentinel/connectors" className="underline">Set up a connector</Link> first.</p>}
                      </section>
                    )}
                </div>
              </div>
            )}
            <NewInvestigationDialog workspaceId={workspaceId} open={creating} onOpenChange={setCreating} readTools={info.data.readTools} onCreated={(id) => navigate(`/sentinel/${id}`)} />
          </>
        )}
      </div>
    </main>
  );
}
