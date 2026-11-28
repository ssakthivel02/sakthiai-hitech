import { useMemo, useState } from "react";
import { Link } from "wouter";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { SeverityBadge, StatusBadge } from "./StatusBadge";
import { STATUS_META, humanLabel, relativeTime } from "./format";
import type { SentinelSummary } from "./types";

const STATUS_ORDER = ["QUEUED", "RUNNING", "COMPLETED", "ABSTAINED", "FAILED", "CANCELLED"] as const;

export function InvestigationList({ items, loading, error, selectedId, onRetry, status, onStatus, hasMore, loadingMore, onLoadMore }: {
  items: SentinelSummary[] | undefined; loading: boolean; error?: string; selectedId?: string; onRetry: () => void;
  /** server-side status filter ("" = all) */ status: string; onStatus: (s: string) => void;
  hasMore: boolean; loadingMore: boolean; onLoadMore: () => void;
}) {
  const [q, setQ] = useState("");
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (items ?? []).filter((s) => !needle || `${s.title} ${s.service} ${s.label ?? ""}`.toLowerCase().includes(needle));
  }, [items, q]);
  return (
    <section aria-labelledby="sentinel-history" className="rounded-2xl border border-[var(--line)] bg-white p-3 shadow-sm">
      <div className="flex items-center justify-between px-1 pb-2">
        <h2 id="sentinel-history" className="text-sm font-bold tracking-wide text-[var(--ink)]">Investigation history</h2>
        <span className="text-xs text-[var(--muted)]" aria-live="polite">{items ? `${items.length} loaded${hasMore ? "+" : ""}` : ""}</span>
      </div>
      <div className="mb-2 grid gap-2">
        <label className="relative block">
          <span className="sr-only">Search loaded investigations</span>
          <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-[var(--muted)]" aria-hidden />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search title, service, diagnosis" className="w-full rounded-md border border-input bg-white py-2 pl-8 pr-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--deep)]/40" />
        </label>
        <label className="block">
          <span className="sr-only">Filter by status</span>
          <select value={status} onChange={(e) => onStatus(e.target.value)} className="w-full rounded-md border border-input bg-white px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--deep)]/40">
            <option value="">All statuses</option>
            {STATUS_ORDER.map((s) => <option key={s} value={s}>{STATUS_META[s]!.label}</option>)}
          </select>
        </label>
        {q.trim() && <p className="text-xs text-[var(--muted)]">Search covers the investigations loaded so far{hasMore ? "; load more to widen it" : ""}.</p>}
      </div>
      {loading && <div className="space-y-2" aria-busy="true">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-16 w-full rounded-xl" />)}</div>}
      {error && <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-900">Could not load investigations: {error} <button className="ml-1 underline" onClick={onRetry}>Retry</button></div>}
      {!loading && !error && items?.length === 0 && <p className="rounded-xl border border-dashed border-[var(--line)] p-4 text-sm text-[var(--muted)]">{status ? "No investigations with this status." : "No investigations in this workspace yet. Create one from an alert to start."}</p>}
      {!loading && !error && items && items.length > 0 && shown.length === 0 && <p className="p-3 text-sm text-[var(--muted)]">Nothing loaded matches your search.</p>}
      <ul className="space-y-2">
        {shown.map((s) => (
          <li key={s.id}>
            <Link href={`/sentinel/${s.id}`} aria-current={s.id === selectedId ? "page" : undefined}
              className={cn("block rounded-xl border p-3 transition-colors motion-reduce:transition-none hover:border-[var(--deep)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--deep)]/40", s.id === selectedId ? "border-[var(--deep)] bg-lime-50" : "border-[var(--line)] bg-white")}>
              <div className="flex items-start justify-between gap-2">
                <span className="line-clamp-2 text-sm font-semibold text-[var(--ink)]">{s.title}</span>
                <SeverityBadge severity={s.severity} />
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--muted)]">
                <span className="font-mono">{s.service}</span><span aria-hidden>·</span><span>{relativeTime(s.createdAt)}</span>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <StatusBadge status={s.status} />
                {s.outcome === "DIAGNOSIS" && s.label && <span className="text-xs font-medium text-[var(--deep)]">{humanLabel(s.label)}</span>}
              </div>
            </Link>
          </li>
        ))}
      </ul>
      {hasMore && <Button variant="outline" size="sm" className="mt-3 w-full" disabled={loadingMore} onClick={onLoadMore}>{loadingMore ? "Loading…" : "Load older investigations"}</Button>}
    </section>
  );
}
