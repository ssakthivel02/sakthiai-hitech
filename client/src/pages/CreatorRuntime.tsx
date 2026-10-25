import { Link } from "wouter";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowLeft, RefreshCw, ShieldCheck, ShieldX, FlaskConical } from "lucide-react";

export default function CreatorRuntime() {
  const { isAuthenticated, loading } = useAuth();
  const workspaces = trpc.workspace.list.useQuery(undefined, { enabled: isAuthenticated });
  const workspaceId = workspaces.data?.[0]?.workspace.id;
  const preflight = trpc.creator.preflight.useQuery(
    { workspaceId: workspaceId! },
    { enabled: Boolean(workspaceId), refetchInterval: 15_000 },
  );
  const verifyRuntime = trpc.creator.verifyRuntime.useMutation();

  if (loading) return <div className="loading-screen">Loading Creator runtime…</div>;
  if (!isAuthenticated) {
    return <main className="landing"><h1>Creator runtime status requires an authenticated SakthiAI workspace.</h1><Link href="/">Return home</Link></main>;
  }

  const structurallyReady = Boolean(preflight.data?.readyForPaidGeneration);
  const verifiedReady = Boolean(verifyRuntime.data?.readyForPaidGeneration);
  const checks = verifyRuntime.data?.checks ?? preflight.data?.checks ?? [];

  return (
    <main className="workspace" style={{ maxWidth: 1100, margin: "0 auto", padding: 24 }}>
      <header style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "center", marginBottom: 20, flexWrap: "wrap" }}>
        <div>
          <Link href="/creator"><Button variant="ghost" size="sm"><ArrowLeft size={16}/> Creator</Button></Link>
          <div className="eyebrow">SAKTHIAI CREATOR · RUNTIME ACCEPTANCE</div>
          <h2>Paid generation readiness</h2>
          <p>Secret-free checks for configuration plus an explicit live database/schema and storage write/read acceptance before any paid Murugan generation.</p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <Badge variant={verifiedReady ? "default" : "outline"}>{verifiedReady ? <ShieldCheck size={14}/> : <ShieldX size={14}/>} {verifiedReady ? "VERIFIED" : "NOT VERIFIED"}</Badge>
          <Button size="sm" variant="outline" disabled={!workspaceId || preflight.isFetching} onClick={() => preflight.refetch()}><RefreshCw size={14}/> Refresh config</Button>
          <Button
            size="sm"
            disabled={!workspaceId || !structurallyReady || verifyRuntime.isPending}
            onClick={() => workspaceId && verifyRuntime.mutate({ workspaceId })}
          >
            <FlaskConical size={14}/> {verifyRuntime.isPending ? "Verifying…" : "Verify data plane"}
          </Button>
        </div>
      </header>

      <Card style={{ marginBottom: 16 }}>
        <CardHeader><CardTitle>Runtime decision</CardTitle></CardHeader>
        <CardContent style={{ display: "grid", gap: 8 }}>
          <strong>
            {verifiedReady
              ? "Paid generation prerequisites are live-verified for this runtime."
              : structurallyReady
                ? "Configuration is structurally ready, but live data-plane acceptance has not passed in this view."
                : "Paid image/video generation is blocked until the structural checks pass."}
          </strong>
          <small>“Verify data plane” performs a read-only Creator database/schema probe and a tiny SakthiAI-owned storage canary write/read with best-effort cleanup. It does not call Gemini or Veo.</small>
          <small>Runtime readiness never implies production or publication approval. Production approval remains disabled.</small>
          {!workspaceId && <small>No authorised workspace is available yet.</small>}
          {preflight.error && <small>Preflight request failed: {preflight.error.message}</small>}
          {verifyRuntime.error && <small>Runtime acceptance failed: {verifyRuntime.error.message}</small>}
        </CardContent>
      </Card>

      <div style={{ display: "grid", gap: 12 }}>
        {checks.map(check => (
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
          <small>No API key, storage secret or connection string is displayed on this page. A real Gemini/Veo output is still required before either provider can be called operationally proven.</small>
        </CardContent>
      </Card>
    </main>
  );
}
