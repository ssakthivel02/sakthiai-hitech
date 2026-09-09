import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import dashboardData from "@/generated/intelligence-dashboard-data.json";
import { ArrowLeft, BrainCircuit, CheckCircle2, Database, FileSearch, Gauge, LockKeyhole, Mic2, Network, ShieldCheck, Sparkles } from "lucide-react";
import { Link } from "wouter";

const iconByDomain = {
  "SAI-03": Sparkles,
  "SAI-04": Network,
  "SAI-05": Database,
  "SAI-06": FileSearch,
  "SAI-07": Mic2,
  "SAI-08": Gauge,
  "SAI-09": ShieldCheck,
  "SAI-CF": BrainCircuit,
} as const;

const humanizeStatus = (value: string) =>
  value
    .split("-")
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");

export default function IntelligenceDashboard() {
  const metrics = dashboardData.registryMetrics;

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-7xl px-5 py-8 md:px-8 md:py-12">
        <div className="mb-8 flex flex-col gap-5 md:flex-row md:items-start md:justify-between">
          <div>
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              <BrainCircuit size={15} /> SakthiAI Intelligence Control Plane
            </div>
            <h1 className="text-3xl font-bold tracking-tight md:text-5xl">Two-month research corpus, mapped into product architecture.</h1>
            <p className="mt-4 max-w-3xl text-sm leading-6 text-muted-foreground md:text-base">
              Owner-supplied Gemini scheduled-task output: {dashboardData.source.pages} pages ({dashboardData.source.period}). This dashboard is generated from governed research manifests rather than duplicated presentation constants.
            </p>
          </div>
          <Link href="/"><Button variant="outline"><ArrowLeft size={16} /> Workspace</Button></Link>
        </div>

        <div className="mb-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Card><CardContent className="pt-6"><div className="text-sm text-muted-foreground">Source corpus</div><div className="mt-1 text-3xl font-bold">{dashboardData.source.pages}</div><div className="text-xs text-muted-foreground">pages supplied by owner</div></CardContent></Card>
          <Card><CardContent className="pt-6"><div className="text-sm text-muted-foreground">Mapped domains</div><div className="mt-1 text-3xl font-bold">{dashboardData.domains.length}</div><div className="text-xs text-muted-foreground">governed research destinations</div></CardContent></Card>
          <Card><CardContent className="pt-6"><div className="text-sm text-muted-foreground">Paid activation</div><div className="mt-1 text-3xl font-bold">{dashboardData.policy.paidProviderActivationApproved ? "APPROVED" : "BLOCKED"}</div><div className="text-xs text-muted-foreground">owner approval required before enablement</div></CardContent></Card>
          <Card><CardContent className="pt-6"><div className="text-sm text-muted-foreground">Runtime truth</div><div className="mt-1 text-3xl font-bold">{dashboardData.source.productionTruth ? "ACTIVE" : "GATED"}</div><div className="text-xs text-muted-foreground">primary-source re-verification required</div></CardContent></Card>
        </div>

        <Card className="mb-8 border-amber-500/30">
          <CardContent className="flex gap-3 pt-6">
            <LockKeyhole className="mt-0.5 shrink-0" size={20} />
            <div><strong>Research is evidence, not production approval.</strong><p className="mt-1 text-sm leading-6 text-muted-foreground">Provider versions, pricing, licensing, privacy, limits and model claims must be re-verified from authoritative primary sources before runtime use. Production approval is currently {dashboardData.policy.productionApproved ? "enabled" : "disabled"}.</p></div>
          </CardContent>
        </Card>

        <div className="mb-8 grid gap-4 md:grid-cols-3">
          <Card><CardHeader className="pb-2"><CardTitle className="text-base">Document & RAG</CardTitle></CardHeader><CardContent><div className="text-3xl font-bold">{metrics.documentRag.normalizedRecords}</div><p className="mt-1 text-sm text-muted-foreground">normalized architecture patterns from the {metrics.documentRag.sourceCheckpoint}-record source checkpoint</p></CardContent></Card>
          <Card><CardHeader className="pb-2"><CardTitle className="text-base">Evaluation</CardTitle></CardHeader><CardContent><div className="text-3xl font-bold">{metrics.evaluation.ownedSpecifications}</div><p className="mt-1 text-sm text-muted-foreground">SakthiAI-owned benchmark specifications across {metrics.evaluation.evaluationDimensions} evaluation dimensions</p></CardContent></Card>
          <Card><CardHeader className="pb-2"><CardTitle className="text-base">Security</CardTitle></CardHeader><CardContent><div className="text-3xl font-bold">{metrics.security.normalizedRecords}</div><p className="mt-1 text-sm text-muted-foreground">normalized defensive threat/control records · defensive-only {metrics.security.defensiveOnly ? "enforced" : "not enforced"}</p></CardContent></Card>
        </div>

        <div className="grid gap-5 lg:grid-cols-2">
          {dashboardData.domains.map(domain => {
            const Icon = iconByDomain[domain.id as keyof typeof iconByDomain] ?? BrainCircuit;
            return <Card key={domain.id} className="overflow-hidden">
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex gap-3"><div className="rounded-xl border p-2.5"><Icon size={20} /></div><div><div className="text-xs font-semibold tracking-wider text-muted-foreground">{domain.id}</div><CardTitle className="mt-1 text-xl">{domain.name}</CardTitle></div></div>
                  <Badge variant="outline">{humanizeStatus(domain.status)}</Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm leading-6 text-muted-foreground">{domain.use}</p>
                <div className="rounded-lg bg-muted/45 p-3 text-sm"><div className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Repository destination</div><code>{domain.destination}</code><div className="mt-2 text-xs text-muted-foreground">Surfaces: {domain.surfaces.join(", ")}</div></div>
                <div className="flex gap-2 text-sm"><CheckCircle2 className="mt-0.5 shrink-0" size={16} /><span>{domain.evidence}</span></div>
              </CardContent>
            </Card>;
          })}
        </div>

        <Card className="mt-8">
          <CardHeader><CardTitle>Promotion rules</CardTitle></CardHeader>
          <CardContent className="grid gap-3 text-sm md:grid-cols-2">
            <div className="rounded-lg border p-4"><strong>Website / dashboard</strong><p className="mt-1 text-muted-foreground">Expose capability taxonomy, verification state, evaluation/security posture and architecture decisions. Never market research-only capabilities as live.</p></div>
            <div className="rounded-lg border p-4"><strong>Server / runtime</strong><p className="mt-1 text-muted-foreground">Use provider-neutral adapters. Runtime binding remains blocked until current official API, pricing, licensing, privacy and safety verification.</p></div>
            <div className="rounded-lg border p-4"><strong>Mobile apps</strong><p className="mt-1 text-muted-foreground">Reuse shared server capability contracts and local-model profiles rather than creating vendor-specific mobile architecture.</p></div>
            <div className="rounded-lg border p-4"><strong>CI / governance</strong><p className="mt-1 text-muted-foreground">Generated dashboard data, stable IDs, provenance, verification state, tenant isolation and approval state remain machine-checkable.</p></div>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
