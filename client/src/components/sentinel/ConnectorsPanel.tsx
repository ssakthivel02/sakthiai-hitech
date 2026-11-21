import { useMemo, useState } from "react";
import { CheckCircle2, CircleHelp, FlaskConical, KeyRound, Plug, Plus, RefreshCw, Trash2, XCircle } from "lucide-react";
import { toast } from "sonner";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { trpc } from "@/lib/trpc";
import { RegisterConnectorDialog } from "./RegisterConnectorDialog";
import { ToneBadge } from "./StatusBadge";
import { LOCALITY_SHORT, LOCALITY_TONE, OUTCOME_TONE, READ_TOOL_HINTS, formatTime, toolCoverage } from "./format";
import type { ConnectorAuditRow, ConnectorInfo, DiscoveryResult } from "./types";

type Check = { at: string; result?: DiscoveryResult; error?: string };

function ConnectorCard({ c, canManage, workspaceId, check, busy, onToggle, onTest, onRemove }: {
  c: ConnectorInfo; canManage: boolean; workspaceId: number; check?: Check; busy: boolean;
  onToggle: (enabled: boolean) => void; onTest: () => void; onRemove: () => void;
}) {
  void workspaceId;
  const why = !canManage ? "Only workspace owners can change connectors." : undefined;
  const status = !check ? { tone: "info" as const, label: "Not checked", Icon: CircleHelp } : check.error ? { tone: "bad" as const, label: "Check failed", Icon: XCircle } : { tone: "ok" as const, label: "Reachable", Icon: CheckCircle2 };
  return (
    <li className="rounded-2xl border border-[var(--line)] bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex flex-wrap items-center gap-2 text-base font-bold"><Plug className="size-4 text-[var(--deep)]" aria-hidden /> {c.name}
            <ToneBadge tone={LOCALITY_TONE[c.locality] ?? "info"}>{c.synthetic && <FlaskConical aria-hidden />}{LOCALITY_SHORT[c.locality] ?? c.locality}</ToneBadge>
            <ToneBadge tone={c.enabled ? "ok" : "info"}>{c.enabled ? "Enabled" : "Disabled"}</ToneBadge>
            {c.hasSecret && <ToneBadge tone="info"><KeyRound aria-hidden /> Credential attached (hidden)</ToneBadge>}
          </h3>
          <p className="mt-1 break-all font-mono text-xs text-[var(--muted)]">{c.endpoint}</p>
          <p className="mt-1 text-xs text-[var(--muted)]">{c.localityLabel}</p>
        </div>
        <label className="flex items-center gap-2 text-sm" title={why}>
          <span className="font-medium">{c.enabled ? "Enabled" : "Disabled"}</span>
          <Switch checked={c.enabled} disabled={!canManage || busy} onCheckedChange={onToggle} aria-label={`${c.enabled ? "Disable" : "Enable"} connector ${c.name}`} />
        </label>
      </div>

      <dl className="mt-3 grid gap-3 text-xs sm:grid-cols-3">
        <div><dt className="text-[var(--muted)]">Timeout</dt><dd className="font-mono text-sm">{c.timeoutMs} ms</dd></div>
        <div><dt className="text-[var(--muted)]">Max response</dt><dd className="font-mono text-sm">{c.maxResponseBytes.toLocaleString()} bytes</dd></div>
        <div><dt className="text-[var(--muted)]">Tool allowlist</dt><dd className="font-mono text-sm">{c.allowedTools?.length ? c.allowedTools.join(", ") : "all read-only tools"}</dd></div>
      </dl>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" disabled={!canManage || !c.enabled || busy} onClick={onTest} title={why ?? (c.enabled ? undefined : "Enable the connector before testing it")}>
          <RefreshCw className="size-4" aria-hidden /> Test connection &amp; list tools
        </Button>
        <ToneBadge tone={status.tone}><status.Icon aria-hidden /> {status.label}</ToneBadge>
        {check && <span className="text-xs text-[var(--muted)]">checked {formatTime(check.at)}</span>}
        {!c.enabled && <span className="text-xs text-[var(--muted)]">Enable it to test or use it.</span>}
        <div className="ml-auto">
          <AlertDialog>
            <AlertDialogTrigger asChild><Button variant="ghost" size="sm" disabled={!canManage || busy} title={why}><Trash2 className="size-4" aria-hidden /> Remove</Button></AlertDialogTrigger>
            <AlertDialogContent className="bg-white">
              <AlertDialogHeader><AlertDialogTitle>Remove “{c.name}”?</AlertDialogTitle><AlertDialogDescription>Sentinel can no longer use this connector. Investigations already bound to it will report the connector as unavailable instead of producing evidence. The removal is recorded in the audit log.</AlertDialogDescription></AlertDialogHeader>
              <AlertDialogFooter><AlertDialogCancel>Keep it</AlertDialogCancel><AlertDialogAction onClick={onRemove}>Remove connector</AlertDialogAction></AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      {check?.error && <p role="alert" className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900">Could not reach this connector: {check.error}</p>}
      {check?.result && (
        <div className="mt-3 space-y-3 rounded-xl bg-slate-50 p-3 text-sm">
          <p className="text-xs text-[var(--muted)]">Server: <span className="font-mono">{check.result.serverName ?? "unknown"}{check.result.serverVersion ? ` ${check.result.serverVersion}` : ""}</span> · {check.result.tools.length} usable read-only tool(s) · {check.result.deniedTools.length} denied{check.result.malformedTools ? ` · ${check.result.malformedTools} malformed` : ""}</p>
          <div>
            <h4 className="text-xs font-bold uppercase tracking-wide text-[var(--muted)]">Permitted (server-declared read-only)</h4>
            {check.result.tools.length === 0 ? <p className="mt-1 text-xs text-amber-800">This connector exposes no tool Sentinel may call.</p> : (
              <ul className="mt-1 grid gap-1 sm:grid-cols-2">{check.result.tools.map((t) => <li key={t.name} className="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1"><span className="font-mono text-xs font-semibold">{t.name}</span>{t.description && <span className="block text-[11px] text-[var(--muted)]">{t.description}</span>}</li>)}</ul>
            )}
          </div>
          {check.result.deniedTools.length > 0 && (
            <div>
              <h4 className="text-xs font-bold uppercase tracking-wide text-[var(--muted)]">Denied by policy</h4>
              <ul className="mt-1 space-y-1">{check.result.deniedTools.map((t) => <li key={t.name} className="flex flex-wrap gap-x-2 rounded-md border border-red-200 bg-red-50 px-2 py-1 text-xs"><span className="font-mono font-semibold">{t.name}</span><span className="text-red-900">{t.reason}</span></li>)}</ul>
            </div>
          )}
          <p className="text-[11px] text-[var(--muted)]">Permissions come from server policy and the owner&apos;s allowlist. The model cannot change them, and denied tools can never be bound to an investigation.</p>
        </div>
      )}
    </li>
  );
}

function AuditTable({ rows, names }: { rows: ConnectorAuditRow[]; names: Map<string, string> }) {
  if (!rows.length) return <p className="text-sm text-[var(--muted)]">No connector activity recorded yet.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] text-left text-xs">
        <caption className="sr-only">Connector audit history</caption>
        <thead><tr className="border-b border-[var(--line)] text-[var(--muted)]"><th scope="col" className="py-1.5 pr-3 font-semibold">Time</th><th scope="col" className="pr-3 font-semibold">Connector</th><th scope="col" className="pr-3 font-semibold">Action</th><th scope="col" className="pr-3 font-semibold">Target</th><th scope="col" className="pr-3 font-semibold">Outcome</th><th scope="col" className="font-semibold">User</th></tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.id} className="border-b border-[var(--line)]/60 align-top">
            <td className="py-1.5 pr-3 whitespace-nowrap">{formatTime(new Date(r.createdAt).toISOString())}</td>
            <td className="pr-3">{names.get(r.connectorId) ?? <span className="font-mono">{r.connectorId.slice(0, 8)} (removed)</span>}</td>
            <td className="pr-3 font-mono">{r.action}</td><td className="pr-3 font-mono break-all">{r.target ?? "–"}</td>
            <td className="pr-3"><ToneBadge tone={OUTCOME_TONE[r.outcome] ?? "info"}>{r.outcome}</ToneBadge>{r.detail && <span className="ml-1 text-[var(--muted)]">{r.detail}</span>}</td>
            <td>{r.actorUserId ? `#${r.actorUserId}` : "system"}</td>
          </tr>))}</tbody>
      </table>
    </div>
  );
}

export function ConnectorsPanel({ workspaceId }: { workspaceId: number }) {
  const utils = trpc.useUtils();
  const catalog = trpc.sentinel.connectorCatalog.useQuery({ workspaceId });
  const [checks, setChecks] = useState<Record<string, Check>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [registering, setRegistering] = useState(false);
  const canManage = catalog.data?.canManage ?? false;
  const audit = trpc.connectors.mcp.audit.useQuery({ workspaceId, limit: 50 }, { enabled: canManage });
  const refresh = () => { void utils.sentinel.connectorCatalog.invalidate(); void utils.connectors.mcp.list.invalidate(); void utils.connectors.mcp.audit.invalidate(); };

  const setEnabled = trpc.connectors.mcp.setEnabled.useMutation({ onError: (e) => toast.error(e.message), onSettled: () => { setBusyId(null); refresh(); } });
  const remove = trpc.connectors.mcp.remove.useMutation({ onSuccess: () => toast.success("Connector removed"), onError: (e) => toast.error(e.message), onSettled: () => { setBusyId(null); refresh(); } });
  const discover = trpc.connectors.mcp.discover.useMutation();

  const test = async (id: string) => {
    setBusyId(id);
    try { const result = await discover.mutateAsync({ workspaceId, connectorId: id }); setChecks((m) => ({ ...m, [id]: { at: new Date().toISOString(), result } })); }
    catch (e) { setChecks((m) => ({ ...m, [id]: { at: new Date().toISOString(), error: e instanceof Error ? e.message : "connection check failed" } })); }
    finally { setBusyId(null); void utils.connectors.mcp.audit.invalidate(); }
  };

  const data = catalog.data;
  const found = useMemo(() => (data?.connectors ?? []).flatMap((c) => { const r = checks[c.id]?.result; return c.enabled && r ? [{ connectorId: c.id, connectorName: c.name, tools: r.tools.map((t) => t.name) }] : []; }), [data, checks]);
  const coverage = useMemo(() => toolCoverage(data?.readTools ?? [], found), [data, found]);
  const names = useMemo(() => new Map((data?.connectors ?? []).map((c) => [c.id, c.name])), [data]);

  if (catalog.isLoading) return <div className="space-y-3" aria-busy="true"><Skeleton className="h-24 w-full rounded-2xl" /><Skeleton className="h-40 w-full rounded-2xl" /></div>;
  if (catalog.error) return <div role="alert" className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">Could not load connectors: {catalog.error.message} <button className="ml-1 underline" onClick={() => void catalog.refetch()}>Retry</button></div>;
  if (!data) return null;

  return (
    <div className="space-y-5">
      <section aria-labelledby="cn-intro" className="flex flex-wrap items-start justify-between gap-3 rounded-2xl border border-[var(--line)] bg-white p-4 shadow-sm">
        <div className="min-w-0 max-w-2xl">
          <h2 id="cn-intro" className="text-base font-bold">Diagnostic connectors</h2>
          <p className="mt-1 text-sm text-[var(--muted)]">Sentinel reads logs, metrics and other diagnostics only through governed, read-only MCP connectors registered in this workspace. Writes are impossible: a tool must be declared read-only by its server and pass policy before it can be bound.</p>
          {!canManage && <p className="mt-2 rounded-lg bg-slate-50 p-2 text-xs text-[var(--muted)]">You can view connectors. Only workspace owners can register, enable, test or remove them.</p>}
        </div>
        <Button disabled={!canManage || !data.config} onClick={() => setRegistering(true)} title={canManage ? undefined : "Only workspace owners can register connectors"} className="bg-[var(--deep)] text-white hover:bg-[var(--deep)]/90"><Plus className="size-4" aria-hidden /> Register connector</Button>
      </section>

      {data.config && (
        <section aria-labelledby="cn-cfg" className="rounded-2xl border border-[var(--line)] bg-white p-4">
          <h2 id="cn-cfg" className="text-sm font-bold">Operator-approved configuration</h2>
          <div className="mt-2 grid gap-3 text-sm sm:grid-cols-3">
            <div><div className="text-xs text-[var(--muted)]">Approved endpoints</div>{data.config.approvedOrigins.length ? <ul className="mt-1 space-y-1">{data.config.approvedOrigins.map((o) => <li key={o.origin} className="flex flex-wrap items-center gap-1"><span className="break-all font-mono text-xs">{o.origin}</span><ToneBadge tone={LOCALITY_TONE[o.locality] ?? "info"}>{LOCALITY_SHORT[o.locality]}</ToneBadge></li>)}</ul> : <p className="mt-1 text-xs text-amber-800">None. Registration is blocked until an administrator approves an origin.</p>}</div>
            <div><div className="text-xs text-[var(--muted)]">Credential references</div>{data.config.secretRefs.length ? <p className="mt-1 font-mono text-xs">{data.config.secretRefs.join(", ")}</p> : <p className="mt-1 text-xs text-[var(--muted)]">None provisioned (names only are ever shown; values are never sent to the browser).</p>}</div>
            <div><div className="text-xs text-[var(--muted)]">Network rules</div><p className="mt-1 text-xs">Loopback HTTP: <b>{data.config.loopbackHttpAllowed ? "allowed (development)" : "blocked"}</b><br />Private networks: <b>{data.config.privateNetworkAllowed ? "allowed" : "blocked"}</b></p></div>
          </div>
        </section>
      )}

      {data.connectors.length === 0 ? (
        <section className="rounded-2xl border border-dashed border-[var(--line)] bg-white p-8 text-center">
          <Plug className="mx-auto size-8 text-[var(--deep)]" aria-hidden />
          <h2 className="mt-2 text-base font-bold">No connectors yet</h2>
          <p className="mx-auto mt-1 max-w-md text-sm text-[var(--muted)]">Register a read-only MCP server so Sentinel has something to investigate with. Until then, investigations cannot gather evidence.</p>
        </section>
      ) : (
        <ul className="space-y-3" aria-label="Registered connectors">
          {data.connectors.map((c) => (
            <ConnectorCard key={c.id} c={c} workspaceId={workspaceId} canManage={canManage} busy={busyId === c.id} check={checks[c.id]}
              onToggle={(enabled) => { setBusyId(c.id); setEnabled.mutate({ workspaceId, connectorId: c.id, enabled }); if (!enabled) setChecks((m) => { const { [c.id]: _gone, ...rest } = m; return rest; }); }}
              onTest={() => void test(c.id)}
              onRemove={() => { setBusyId(c.id); remove.mutate({ workspaceId, connectorId: c.id }); setChecks((m) => { const { [c.id]: _gone, ...rest } = m; return rest; }); }} />
          ))}
        </ul>
      )}

      <section aria-labelledby="cn-cov" className="rounded-2xl border border-[var(--line)] bg-white p-4">
        <h2 id="cn-cov" className="text-sm font-bold">What Sentinel can investigate with</h2>
        <p className="mt-1 text-xs text-[var(--muted)]">Based on tools discovered in this session. Run “Test connection &amp; list tools” on an enabled connector to fill this in. Matching is a suggestion; you confirm each binding when starting an investigation.</p>
        <ul className="mt-3 grid gap-2 sm:grid-cols-2">{coverage.map((r) => (
          <li key={r.tool} className="rounded-lg border border-[var(--line)] p-2 text-xs">
            <div className="font-semibold">{READ_TOOL_HINTS[r.tool]?.title ?? r.tool} <span className="font-mono font-normal text-[var(--muted)]">{r.tool}</span></div>
            {r.mcpTool ? <div className="mt-0.5 text-emerald-800">Can use <span className="font-mono">{r.mcpTool}</span> on {r.connectorName}</div> : <div className="mt-0.5 text-[var(--muted)]">{found.length ? "No matching read-only tool discovered" : "Not yet discovered"}</div>}
          </li>))}</ul>
      </section>

      <section aria-labelledby="cn-audit" className="rounded-2xl border border-[var(--line)] bg-white p-4">
        <h2 id="cn-audit" className="text-sm font-bold">Connector audit history</h2>
        {!canManage && <p className="mt-2 text-sm text-[var(--muted)]">The workspace-wide audit history is visible to workspace owners.</p>}
        {canManage && audit.isLoading && <p className="mt-2 text-sm text-[var(--muted)]">Loading…</p>}
        {canManage && audit.error && <p role="alert" className="mt-2 text-sm text-red-800">Could not load the audit history: {audit.error.message}</p>}
        {canManage && audit.data && <div className="mt-2"><AuditTable rows={audit.data} names={names} /></div>}
      </section>

      {data.config && <RegisterConnectorDialog workspaceId={workspaceId} config={data.config} open={registering} onOpenChange={setRegistering} onRegistered={(id) => { setChecks((m) => { const { [id]: _g, ...rest } = m; return rest; }); refresh(); }} />}
    </div>
  );
}
