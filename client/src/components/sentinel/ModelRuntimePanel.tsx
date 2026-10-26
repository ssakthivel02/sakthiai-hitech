import { useState } from "react";
import { Gauge } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { ToneBadge } from "./StatusBadge";
import { budgetLine, providerLine, recentLine } from "./runtimeFormat";

/** Workspace-owner view of the Provider Gateway. Opened on demand; the server enforces the owner role and returns no URL, key or prompt. */
export function ModelRuntimePanel({ workspaceId }: { workspaceId: number }) {
  const [open, setOpen] = useState(false);
  const q = trpc.modelRuntime.status.useQuery({ workspaceId }, { enabled: open, refetchOnWindowFocus: false, retry: false });
  const d = q.data;
  const forbidden = q.error?.data?.code === "FORBIDDEN";
  return (
    <details className="mb-4 rounded-xl border border-[var(--line)] bg-white p-3" onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)} data-testid="model-runtime">
      <summary className="flex cursor-pointer items-center gap-2 text-sm font-semibold"><Gauge className="size-4" aria-hidden /> Model runtime and budget <span className="font-normal text-[var(--muted)]">(workspace owners)</span></summary>
      <div className="mt-3 grid gap-3 text-sm">
        {q.isLoading && open && <span>Loading…</span>}
        {forbidden && <span role="status">Only a workspace owner can see provider and budget details.</span>}
        {q.error && !forbidden && <span role="alert">Could not load runtime details: {q.error.message}</span>}
        {d && (
          <>
            <ul aria-label="Providers" className="grid gap-2">
              {d.providers.map((p) => { const l = providerLine(p as never); return (
                <li key={p.providerId} className="rounded-lg border border-[var(--line)] p-2">
                  <div className="flex flex-wrap items-center gap-2"><strong>{l.title}</strong><ToneBadge tone={l.tone}>{l.state}</ToneBadge></div>
                  <p className="mt-1 text-xs text-[var(--muted)]">{l.detail}</p>
                </li>); })}
            </ul>
            <div>
              <strong>Today (UTC) for this workspace</strong>
              {d.workspace.policyError || d.workspace.usageError
                ? <p role="status" className="text-xs">Budget details are unavailable right now ({d.workspace.policyError ? "policy" : "usage"} could not be read). External calls fail closed in that state.</p>
                : !d.workspace.policy?.externalEnabled
                  ? <p className="text-xs text-[var(--muted)]">External providers are not enabled for this workspace, so no hosted-model spend can occur.</p>
                  : (
                    <ul className="mt-1 text-xs">
                      <li>{budgetLine("Requests", d.workspace.usageToday?.requests, d.workspace.policy.maxRequests, d.workspace.remaining?.requests)}</li>
                      <li>{budgetLine("Tokens", d.workspace.usageToday?.tokens, d.workspace.policy.maxTokens, d.workspace.remaining?.tokens)}</li>
                      <li>{budgetLine("Estimated cost", d.workspace.usageToday?.cost, d.workspace.policy.maxCost, d.workspace.remaining?.cost, d.workspace.costUnit ?? "")}</li>
                    </ul>)}
              <p className="mt-1 text-xs text-[var(--muted)]">Cost is {d.workspace.costBasis}. Budget store: {d.budgetStore === "none" ? "none (external metered calls are refused)" : d.budgetStore === "memory" ? "in memory (resets when the server restarts)" : "database (shared)"}.</p>
            </div>
            <div>
              <strong>Since the server started</strong>
              <p className="text-xs">Refused by budget {d.counters.budget_denied} · by policy {d.counters.policy_denied} · other failures {d.counters.other_failed} · answered {d.counters.returned} (after fallback {d.counters.fellBack}). <span className="text-[var(--muted)]">All workspaces, this process only; not durable.</span></p>
              {d.recent.length === 0 ? <p className="text-xs text-[var(--muted)]">No model calls from this workspace since the server started.</p> : (
                <ol aria-label="Recent calls" className="mt-1 grid gap-1 text-xs">
                  {d.recent.slice(0, 10).map((r, i) => <li key={`${r.at}-${i}`}><time dateTime={r.at}>{new Date(r.at).toLocaleTimeString()}</time> · {recentLine(r)}</li>)}
                </ol>)}
            </div>
          </>
        )}
      </div>
    </details>
  );
}
