import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { describeCreatorError } from "@shared/creatorErrors";

/** Administrator-only Creator spend visibility (UTC day) and stale-reservation reconciliation. Server enforces admin. */
export default function CreatorSpendAdminPanel() {
  const summary = trpc.creator.spend.summary.useQuery(undefined, { refetchOnWindowFocus: false });
  const reconcile = trpc.creator.spend.reconcile.useMutation({ onSuccess: () => summary.refetch() });
  const [confirmApply, setConfirmApply] = useState(false);
  const data = summary.data;
  const failure = summary.error ?? reconcile.error;

  return (
    <Card style={{ marginBottom: 16 }} aria-labelledby="creator-spend-admin-title" data-testid="creator-spend-admin">
      <CardHeader>
        <CardTitle id="creator-spend-admin-title">Creator spend (administrator, {data?.day ?? "UTC today"})</CardTitle>
      </CardHeader>
      <CardContent style={{ display: "grid", gap: 8 }}>
        {failure && <span role="alert">{describeCreatorError(failure.message).title}: {describeCreatorError(failure.message).detail}</span>}
        {summary.isLoading && <span>Loading spend…</span>}
        {data && (
          <>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <Badge variant={data.policy.enabled ? "default" : "outline"}>{data.policy.enabled ? "Paid generation ON" : "Paid generation OFF"}</Badge>
              {data.policy.enabled && !data.policy.valid && <Badge variant="destructive">Policy invalid: {"reason" in data.policy ? data.policy.reason : ""}</Badge>}
              <Badge variant="outline">Approved: {data.allowlistedUsers.image} image · {data.allowlistedUsers.video} video</Badge>
            </div>
            <span>
              Today: {data.global.generations} generations · cost {data.global.cost.toFixed(4)}
              {"limits" in data.policy && data.policy.limits ? ` of ${data.policy.limits.globalGenerations} / ${data.policy.limits.globalCost}` : ""}
            </span>
            <span>
              Reservations: {Object.entries(data.holdsToday).map(([state, v]) => `${state} ${v.holds}`).join(" · ") || "none"} — stale HELD {data.staleHeld.holds} (cost {data.staleHeld.cost.toFixed(4)}, older than {data.staleHeld.olderThanMinutes} min)
            </span>
            {data.topWorkspaces.length > 0 && <small>Top workspaces: {data.topWorkspaces.map(w => `#${w.id} ${w.generations}/${w.cost.toFixed(2)}`).join(", ")}</small>}
            {data.topUsers.length > 0 && <small>Top users: {data.topUsers.map(u => `#${u.id} ${u.generations}/${u.cost.toFixed(2)}`).join(", ")}</small>}
          </>
        )}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Button size="sm" variant="outline" disabled={reconcile.isPending} onClick={() => reconcile.mutate({ apply: false, staleAfterMinutes: 60 })}>Preview reconciliation</Button>
          {!confirmApply ? (
            <Button size="sm" variant="outline" disabled={reconcile.isPending || !data?.staleHeld.holds} onClick={() => setConfirmApply(true)}>Apply reconciliation…</Button>
          ) : (
            <Button size="sm" variant="destructive" disabled={reconcile.isPending} onClick={() => { setConfirmApply(false); reconcile.mutate({ apply: true, staleAfterMinutes: 60 }); }}>Confirm: settle provable holds</Button>
          )}
        </div>
        {reconcile.data && (
          <small aria-live="polite">
            {reconcile.data.dryRun ? "Preview" : "Applied"}: {reconcile.data.scanned} stale · commit {reconcile.data.commit} · release {reconcile.data.release} · manual {reconcile.data.manual}
            {!reconcile.data.dryRun && ` (settled ${reconcile.data.applied.commit + reconcile.data.applied.release})`}
          </small>
        )}
      </CardContent>
    </Card>
  );
}
