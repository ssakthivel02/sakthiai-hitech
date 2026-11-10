import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";
import { validateRegistration } from "./format";
import type { ConnectorCatalog } from "./types";

const SELECT = "w-full rounded-md border border-input bg-white px-3 py-2 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--deep)]/40";

/**
 * Registers a connector through the EXISTING governed MCP service. The browser never sends or sees a secret: a credential is attached only
 * by choosing the NAME of an operator-provisioned reference. New connectors are created DISABLED and must be enabled explicitly.
 */
export function RegisterConnectorDialog({ workspaceId, config, open, onOpenChange, onRegistered }: { workspaceId: number; config: NonNullable<ConnectorCatalog["config"]>; open: boolean; onOpenChange: (o: boolean) => void; onRegistered: (id: string) => void }) {
  const origins = config.approvedOrigins.map((o) => o.origin);
  const [name, setName] = useState(""); const [endpoint, setEndpoint] = useState(origins[0] ? `${origins[0]}/mcp` : "");
  const [secretRef, setSecretRef] = useState(""); const [timeoutMs, setTimeoutMs] = useState(""); const [maxBytes, setMaxBytes] = useState(""); const [allowed, setAllowed] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const register = trpc.connectors.mcp.register.useMutation({
    onSuccess: (c) => { toast.success(`Connector “${c.name}” registered (disabled until you enable it)`); onOpenChange(false); onRegistered(c.id); setName(""); setAllowed(""); },
    onError: (e) => setErrors([e.message]),
  });
  const noOrigins = origins.length === 0;
  const submit = () => {
    const errs = validateRegistration({ name, endpoint, secretRef, timeoutMs, maxResponseBytes: maxBytes }, origins);
    setErrors(errs); if (errs.length) return;
    const tools = [...new Set(allowed.split(/[\s,]+/).map((t) => t.trim()).filter(Boolean))];
    register.mutate({ workspaceId, name: name.trim(), endpoint: endpoint.trim(), ...(secretRef ? { secretRef } : {}), ...(tools.length ? { allowedTools: tools } : {}), ...(timeoutMs ? { timeoutMs: Number(timeoutMs) } : {}), ...(maxBytes ? { maxResponseBytes: Number(maxBytes) } : {}) });
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-y-auto bg-white sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Register a read-only connector</DialogTitle>
          <DialogDescription>An MCP server Sentinel may read diagnostics from. Only endpoints your administrator approved can be registered, and only tools the server declares read-only can ever be called.</DialogDescription>
        </DialogHeader>
        {noOrigins && <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">No endpoints are approved for this deployment (<code>MCP_ALLOWED_ENDPOINTS</code> is empty). Ask an administrator to approve the server&apos;s origin first; registration is blocked until then.</p>}
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); submit(); }} noValidate>
          <div className="space-y-1"><label htmlFor="rc-name" className="text-sm font-semibold">Name</label><Input id="rc-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={96} placeholder="e.g. prod-observability" /></div>
          <div className="space-y-1">
            <label htmlFor="rc-ep" className="text-sm font-semibold">Endpoint</label>
            <Input id="rc-ep" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="https://host/mcp" inputMode="url" autoComplete="off" />
            {origins.length > 0 && <div className="flex flex-wrap gap-1 pt-1" role="group" aria-label="Approved origins">{origins.map((o) => <button key={o} type="button" onClick={() => setEndpoint(`${o}/mcp`)} className="rounded-full border border-[var(--line)] px-2 py-0.5 font-mono text-[11px] hover:bg-slate-50">{o}</button>)}</div>}
            <p className="text-xs text-[var(--muted)]">Must be an approved origin. Credentials, query strings and fragments are rejected. The server checks the resolved address, so private/metadata targets cannot be used.</p>
          </div>
          <div className="space-y-1">
            <label htmlFor="rc-secret" className="text-sm font-semibold">Credential reference (optional)</label>
            <select id="rc-secret" className={SELECT} value={secretRef} onChange={(e) => setSecretRef(e.target.value)}>
              <option value="">None</option>{config.secretRefs.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            <p className="text-xs text-[var(--muted)]">{config.secretRefs.length ? "Choose a reference your administrator provisioned. The value never reaches this browser." : "No credential references are provisioned. Administrators add them as MCP_SECRET_<NAME> settings."}</p>
          </div>
          <div className="space-y-1"><label htmlFor="rc-allow" className="text-sm font-semibold">Tool allowlist (optional)</label><Input id="rc-allow" value={allowed} onChange={(e) => setAllowed(e.target.value)} placeholder="search_logs, query_metrics" /><p className="text-xs text-[var(--muted)]">Narrows which tools may be used. It can never widen access beyond tools the server declares read-only.</p></div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1"><label htmlFor="rc-to" className="text-sm font-semibold">Timeout (ms)</label><Input id="rc-to" inputMode="numeric" value={timeoutMs} onChange={(e) => setTimeoutMs(e.target.value)} placeholder="8000" /></div>
            <div className="space-y-1"><label htmlFor="rc-mb" className="text-sm font-semibold">Max response (bytes)</label><Input id="rc-mb" inputMode="numeric" value={maxBytes} onChange={(e) => setMaxBytes(e.target.value)} placeholder="262144" /></div>
          </div>
          {errors.length > 0 && <ul role="alert" className="list-disc rounded-lg border border-red-200 bg-red-50 p-3 pl-7 text-sm text-red-900">{errors.map((e, i) => <li key={i}>{e}</li>)}</ul>}
          <p className="flex items-start gap-2 text-xs text-[var(--muted)]"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-[var(--deep)]" aria-hidden /> The connector is created disabled. Registration, enabling and every tool call are written to the connector audit log.</p>
          <DialogFooter><Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Close</Button><Button type="submit" disabled={register.isPending || noOrigins}>{register.isPending ? "Registering…" : "Register connector"}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
