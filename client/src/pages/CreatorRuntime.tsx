import { Link } from "wouter";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowLeft, RefreshCw, ShieldCheck, ShieldX } from "lucide-react";

export default function CreatorRuntime() {
  const { isAuthenticated, loading } = useAuth();
  const workspaces = trpc.workspace.list.useQuery(undefined, { enabled: isAuthenticated });
  const workspaceId = workspaces.data?.[0]?.workspace.id;
  const preflight = trpc.creator.preflight.useQuery(
    { workspaceId: workspaceId! },
    { enabled: Boolean(workspaceId), refetchInterval: 15_000 },
  );

  if (loading) return <div className="loading-screen">Loading Creator runtime…</div>;
  if (!isAuthenticated) {
    return <main className="landing"><h1>Creator runtime status requires an authenticated SakthiAI workspace.</h1><Link href="/">Return home</Link></main>;
  }

  const ready = Boolean(preflight.data?.readyForPaidGeneration);

  return (
    <main className="workspace" style={{ maxWidth: 1100, margin: "0 auto", padding: 24 }}>
      <header style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "center", marginBottom: 20, flexWrap: "wrap" }}>
        <div>
          <Link href="/creator"><Button variant="ghost" size="sm"><ArrowLeft size={16}/> Creator</Button></Link>
          <div className="eyebrow">SAKTHIAI CREATOR · RUNTIME PREFLIGHT</div>
          <h2>Paid generation readiness</h2>
          <p>Secret-free evidence gate for database, storage, image/video providers and FFmpeg before any paid Murugan generation.</p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <Badge variant={ready ? "default" : "outline"}>{ready ? <ShieldCheck size={14}/> : <ShieldX size={14}/>} {ready ? "READY" : "BLOCKED"}</Badge>
          <Button size="sm" variant="outline" disabled={!workspaceId || preflight.isFetching} onClick={() => preflight.refetch()}><RefreshCw size={14}/> Refresh</Button>
        </div>
      </header>

      <Card style={{ marginBottom: 16 }}>
        <CardHeader><CardTitle>Runtime decision</CardTitle></CardHeader>
        <CardContent style={{ display: "grid", gap: 8 }}>
          <strong>{ready ? "Paid image/video generation prerequisites are structurally ready." : "Paid image/video generation is blocked until all required checks pass."}</strong>
          <small>Runtime readiness does not imply production approval. Production approval remains {preflight.data?.productionApproved ? "enabled" : "disabled"}.</small>
          {!workspaceId && <small>No authorised workspace is available yet.</small>}
          {preflight.error && <small>Preflight request failed: {preflight.error.message}</small>}
        </CardContent>
      </Card>

      <div style={{ display: "grid", gap: 12 }}>
        {(preflight.data?.checks ?? []).map(check => (
          <Card key={check.id}>
            <CardContent style={{ paddingTop: 16, display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
              <div style={{ minWidth: 220 }}><strong>{check.id}</strong><div><small>{check.required ? "Required" : "Optional"}</small></div></div>
              <div style={{ flex: 1, minWidth: 260 }}><small>{check.detail}</small></div>
              <Badge variant={check.pass ? "default" : "outline"}>{check.pass ? "PASS" : "FAIL"}</Badge>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card style={{ marginTop: 16 }}>
        <CardContent style={{ paddingTop: 16 }}>
          <small>No API key, storage secret or connection string is displayed on this page. If readiness is BLOCKED, configure the missing dependency only in the approved runtime secret/environment facility, then refresh this page.</small>
        </CardContent>
      </Card>
    </main>
  );
}
