import { useEffect } from "react";
import { trpc } from "@/lib/trpc";

/**
 * Live view of one investigation. A cheap `progress` query polls every 2 s while the investigation is active; the full `get` view is
 * refetched only when the persisted event count or status changes. All data comes from the server; nothing is simulated.
 */
export function useInvestigation(workspaceId: number | undefined, investigationId: string | undefined) {
  const enabled = Boolean(workspaceId && investigationId);
  const args = { workspaceId: workspaceId ?? 0, investigationId: investigationId ?? "00000000-0000-4000-8000-000000000000" };
  const progress = trpc.sentinel.progress.useQuery(args, { enabled, refetchInterval: (q) => (q.state.data?.terminal ? false : 2000), refetchIntervalInBackground: false });
  const view = trpc.sentinel.get.useQuery(args, { enabled, refetchOnWindowFocus: false });
  const { eventCount, status } = progress.data ?? {};
  useEffect(() => {
    if (!enabled || eventCount === undefined) return;
    if (view.data && view.data.integrity.eventCount === eventCount && view.data.investigation.status === status) return;
    void view.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, eventCount, status]);
  return { progress, view };
}

/** Keyset-paginated history. `status` is filtered on the server; further pages load on demand. */
export function useHistory(workspaceId: number | undefined, status: string | undefined, enabled: boolean) {
  return trpc.sentinel.list.useInfiniteQuery(
    { workspaceId: workspaceId ?? 0, limit: 25, ...(status ? { status: status as "QUEUED" } : {}) },
    { enabled: enabled && Boolean(workspaceId), getNextPageParam: (last) => last.nextCursor ?? undefined, refetchInterval: 15_000 },
  );
}
