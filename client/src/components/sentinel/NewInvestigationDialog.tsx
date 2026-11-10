import { useRef, useState } from "react";
import { Plus, ShieldCheck, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc";
import { READ_TOOL_HINTS, draftToBinding, emptyDraft, splitList, suggestMcpTool, validateDrafts, type BindingDraft } from "./format";

const NAME = /^[\w.\-:]{1,120}$/;
const SELECT = "w-full rounded-md border border-input bg-white px-3 py-2 text-sm shadow-xs focus-visible:outline-none";
const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `k-${Date.now()}-${Math.random().toString(36).slice(2)}`);

function Field({ label, hint, children, htmlFor }: { label: string; hint?: string; children: React.ReactNode; htmlFor: string }) {
  return <div className="space-y-1"><label htmlFor={htmlFor} className="text-sm font-semibold">{label}</label>{children}{hint && <p className="text-xs text-[var(--muted)]">{hint}</p>}</div>;
}

export function NewInvestigationDialog({ workspaceId, open, onOpenChange, readTools, onCreated }: { workspaceId: number; open: boolean; onOpenChange: (o: boolean) => void; readTools: string[]; onCreated: (id: string) => void }) {
  const utils = trpc.useUtils();
  const key = useRef(newKey());
  const [title, setTitle] = useState(""); const [severity, setSeverity] = useState("medium"); const [service, setService] = useState("");
  const [related, setRelated] = useState(""); const [hosts, setHosts] = useState(""); const [firedAt, setFiredAt] = useState("");
  const [description, setDescription] = useState(""); const [notes, setNotes] = useState("");
  const [maxCalls, setMaxCalls] = useState(""); const [maxSteps, setMaxSteps] = useState("");
  const [drafts, setDrafts] = useState<BindingDraft[]>([emptyDraft("logs.search")]);
  const [tools, setTools] = useState<Record<string, { loading: boolean; names: string[]; error?: string }>>({});
  const [errors, setErrors] = useState<string[]>([]);

  const connectors = trpc.sentinel.connectorCatalog.useQuery({ workspaceId }, { enabled: open });
  const enabledConnectors = (connectors.data?.connectors ?? []).filter((c) => c.enabled);
  const discover = trpc.connectors.mcp.discover.useMutation();
  const create = trpc.sentinel.create.useMutation({
    onSuccess: (r) => { toast.success(r.created ? "Investigation queued" : "Investigation already exists"); key.current = newKey(); void utils.sentinel.list.invalidate(); onOpenChange(false); onCreated(r.investigationId); },
    onError: (e) => setErrors([e.message]),
  });

  const loadTools = async (connectorId: string): Promise<string[]> => {
    if (!connectorId) return [];
    const known = tools[connectorId];
    if (known) return known.names;
    setTools((t) => ({ ...t, [connectorId]: { loading: true, names: [] } }));
    try {
      const names = (await discover.mutateAsync({ workspaceId, connectorId })).tools.map((x) => x.name);
      setTools((t) => ({ ...t, [connectorId]: { loading: false, names } }));
      return names;
    } catch (e) {
      setTools((t) => ({ ...t, [connectorId]: { loading: false, names: [], error: e instanceof Error ? e.message : "discovery failed" } }));
      return [];
    }
  };
  const patch = (i: number, p: Partial<BindingDraft>) => setDrafts((d) => d.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const pickConnector = async (i: number, connectorId: string) => {
    patch(i, { connectorId, mcpTool: "" });
    if (!connectorId) return;
    const names = await loadTools(connectorId);
    setDrafts((d) => d.map((x, j) => (j === i && x.connectorId === connectorId && !x.mcpTool ? { ...x, mcpTool: suggestMcpTool(x.tool, names) } : x)));
  };

  const submit = () => {
    const errs: string[] = [];
    if (title.trim().length < 3) errs.push("Give the incident a title (at least 3 characters).");
    if (!NAME.test(service.trim())) errs.push("Affected service must be a single name (letters, digits and . _ - :).");
    if (description.trim().length < 5) errs.push("Describe what the alert reported.");
    const rel = splitList(related), hs = splitList(hosts);
    for (const n of [...rel, ...hs]) if (!NAME.test(n)) errs.push(`“${n}” is not a valid service/host name.`);
    errs.push(...validateDrafts(drafts));
    const limits: Record<string, number> = {};
    if (maxCalls) limits.max_tool_calls = Number(maxCalls);
    if (maxSteps) limits.max_steps = Number(maxSteps);
    for (const v of Object.values(limits)) if (!Number.isInteger(v) || v < 1) errs.push("Limits must be whole numbers of at least 1.");
    setErrors(errs);
    if (errs.length) return;
    create.mutate({
      workspaceId, title: title.trim(), severity: severity as "low", service: service.trim(), description: description.trim(),
      ...(firedAt ? { firedAt: new Date(firedAt).toISOString() } : {}), relatedServices: rel, hosts: hs, operatorNotes: splitList(notes.replace(/,/g, "\u0000")).map((x) => x.replace(/\u0000/g, ",")),
      bindings: drafts.map(draftToBinding), ...(Object.keys(limits).length ? { limits } : {}), idempotencyKey: key.current,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-y-auto bg-white sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New investigation</DialogTitle>
          <DialogDescription>Describe the alert and choose the read-only diagnostic tools Sentinel may use. It can only read; it cannot change anything.</DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); submit(); }} noValidate>
          <Field label="Incident title" htmlFor="sn-title"><Input id="sn-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder="e.g. Write failures on orders-db" /></Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Severity" htmlFor="sn-sev"><select id="sn-sev" className={SELECT} value={severity} onChange={(e) => setSeverity(e.target.value)}>{["low", "medium", "high", "critical"].map((s) => <option key={s}>{s}</option>)}</select></Field>
            <Field label="Alert fired at (optional)" htmlFor="sn-fired" hint="Defaults to now."><Input id="sn-fired" type="datetime-local" value={firedAt} onChange={(e) => setFiredAt(e.target.value)} /></Field>
            <Field label="Affected service" htmlFor="sn-svc" hint="The inventory name your tools understand."><Input id="sn-svc" value={service} onChange={(e) => setService(e.target.value)} placeholder="orders-db" /></Field>
            <Field label="Hosts (comma separated)" htmlFor="sn-hosts"><Input id="sn-hosts" value={hosts} onChange={(e) => setHosts(e.target.value)} placeholder="db-1, db-2" /></Field>
          </div>
          <Field label="Related services (optional)" htmlFor="sn-rel"><Input id="sn-rel" value={related} onChange={(e) => setRelated(e.target.value)} placeholder="orders-api, payments" /></Field>
          <Field label="What did the alert report?" htmlFor="sn-desc"><Textarea id="sn-desc" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={4000} /></Field>
          <Field label="Operator notes (optional, one per line)" htmlFor="sn-notes"><Textarea id="sn-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>

          <fieldset className="space-y-3 rounded-xl border border-[var(--line)] p-3">
            <legend className="px-1 text-sm font-bold">Read-only diagnostic tools</legend>
            {connectors.isLoading && <p className="text-sm text-[var(--muted)]">Loading connectors…</p>}
            {connectors.error && <p role="alert" className="text-sm text-red-800">Could not load connectors: {connectors.error.message}</p>}
            {!connectors.isLoading && !connectors.error && enabledConnectors.length === 0 && (
              <p role="status" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">This workspace has no enabled MCP connector. Sentinel needs at least one read-only diagnostic connector (a workspace owner registers it on the Connectors tab). Without one an investigation cannot gather evidence.</p>
            )}
            {drafts.map((d, i) => {
              const names = tools[d.connectorId]?.names ?? [];
              return (
                <div key={i} className="space-y-2 rounded-lg bg-slate-50 p-3">
                  <div className="grid gap-2 sm:grid-cols-3">
                    <div><label className="text-xs font-semibold" htmlFor={`sn-t${i}`}>Provides</label>
                      <select id={`sn-t${i}`} className={SELECT} value={d.tool} onChange={(e) => patch(i, { tool: e.target.value, targetParam: READ_TOOL_HINTS[e.target.value]?.defaultTarget ?? d.targetParam, mcpTool: suggestMcpTool(e.target.value, names) })}>
                        <option value="">Choose…</option>{readTools.map((t) => <option key={t} value={t}>{READ_TOOL_HINTS[t]?.title ?? t} ({t})</option>)}
                      </select></div>
                    <div><label className="text-xs font-semibold" htmlFor={`sn-c${i}`}>Connector</label>
                      <select id={`sn-c${i}`} className={SELECT} value={d.connectorId} onChange={(e) => void pickConnector(i, e.target.value)}>
                        <option value="">Choose…</option>{enabledConnectors.map((c) => <option key={c.id} value={c.id}>{c.name}{c.synthetic ? " (synthetic · loopback)" : ""}</option>)}
                      </select></div>
                    <div><label className="text-xs font-semibold" htmlFor={`sn-m${i}`}>Connector tool</label>
                      <select id={`sn-m${i}`} className={SELECT} value={d.mcpTool} onChange={(e) => patch(i, { mcpTool: e.target.value })} disabled={!d.connectorId || tools[d.connectorId]?.loading}>
                        <option value="">{tools[d.connectorId]?.loading ? "Discovering…" : "Choose…"}</option>{names.map((n) => <option key={n} value={n}>{n}</option>)}
                      </select></div>
                  </div>
                  {d.connectorId && tools[d.connectorId]?.error && <p role="alert" className="text-xs text-red-800">Discovery failed: {tools[d.connectorId]!.error}</p>}
                  {d.connectorId && !tools[d.connectorId]?.loading && !tools[d.connectorId]?.error && names.length === 0 && tools[d.connectorId] && <p className="text-xs text-amber-800">This connector exposes no read-only tool Sentinel may call.</p>}
                  <div className="grid gap-2 sm:grid-cols-3">
                    <div><label className="text-xs font-semibold" htmlFor={`sn-p${i}`}>Target argument</label><Input id={`sn-p${i}`} value={d.targetParam} onChange={(e) => patch(i, { targetParam: e.target.value })} /></div>
                    <div><label className="text-xs font-semibold" htmlFor={`sn-q${i}`}>Query argument (optional)</label><Input id={`sn-q${i}`} value={d.queryParam} onChange={(e) => patch(i, { queryParam: e.target.value })} /></div>
                    <div><label className="text-xs font-semibold" htmlFor={`sn-w${i}`}>Window argument (optional)</label><Input id={`sn-w${i}`} value={d.windowParam} onChange={(e) => patch(i, { windowParam: e.target.value })} /></div>
                  </div>
                  {drafts.length > 1 && <Button type="button" variant="ghost" size="sm" onClick={() => setDrafts((x) => x.filter((_, j) => j !== i))}><Trash2 className="size-4" aria-hidden /> Remove</Button>}
                </div>
              );
            })}
            <Button type="button" variant="outline" size="sm" disabled={drafts.length >= readTools.length} onClick={() => setDrafts((d) => [...d, emptyDraft(readTools.find((t) => !d.some((x) => x.tool === t)) ?? "")])}><Plus className="size-4" aria-hidden /> Add tool</Button>
          </fieldset>

          <details className="rounded-xl border border-[var(--line)] p-3 text-sm">
            <summary className="cursor-pointer font-semibold">Budget (optional)</summary>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <Field label="Max tool calls" htmlFor="sn-mc" hint="Default 8, ceiling 15."><Input id="sn-mc" inputMode="numeric" value={maxCalls} onChange={(e) => setMaxCalls(e.target.value)} /></Field>
              <Field label="Max steps" htmlFor="sn-ms" hint="Default 12, ceiling 20."><Input id="sn-ms" inputMode="numeric" value={maxSteps} onChange={(e) => setMaxSteps(e.target.value)} /></Field>
            </div>
          </details>

          {errors.length > 0 && <ul role="alert" className="list-disc rounded-lg border border-red-200 bg-red-50 p-3 pl-7 text-sm text-red-900">{errors.map((e, i) => <li key={i}>{e}</li>)}</ul>}
          <p className="flex items-start gap-2 text-xs text-[var(--muted)]"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-[var(--deep)]" aria-hidden /> Tool output is treated as untrusted data. Any remediation Sentinel suggests is a proposal that needs human approval; it is never executed.</p>
          <DialogFooter><Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Close</Button><Button type="submit" disabled={create.isPending}>{create.isPending ? "Starting…" : "Start investigation"}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
