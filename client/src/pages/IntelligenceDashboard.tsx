import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowLeft, BrainCircuit, CheckCircle2, Database, FileSearch, Gauge, LockKeyhole, Mic2, Network, ShieldCheck, Sparkles } from "lucide-react";
import { Link } from "wouter";

const domains = [
  { id: "SAI-03", name: "Generative Media", status: "Integrating", icon: Sparkles, destination: "research/generative-media", use: "Image, video, audio, avatar, dubbing, prompting and media workflows", evidence: "Provider/model capability layer already started" },
  { id: "SAI-04", name: "Provider & API Intelligence", status: "Reviewed", icon: Network, destination: "research/providers", use: "LLMs, embeddings, rerankers, search, gateways, API policy and pricing", evidence: "Primary-source re-verification required before runtime binding" },
  { id: "SAI-05", name: "Local & Offline AI", status: "Source phase complete", icon: Database, destination: "research/local-models", use: "Open-weight models, licenses, hardware profiles and local runtimes", evidence: "70-record completion checkpoint in supplied Gemini corpus" },
  { id: "SAI-06", name: "Document, Data & RAG", status: "RAG phase complete", icon: FileSearch, destination: "research/document-rag", use: "PDF/DOCX/XLSX/PPTX ingestion, provenance, retrieval, reranking and multimodal RAG", evidence: "79-record RAG completion checkpoint in supplied Gemini corpus" },
  { id: "SAI-07", name: "Conversational Voice", status: "Reviewed", icon: Mic2, destination: "research/voice", use: "VAD, ASR, S2S, TTS, barge-in, Tamil-English code switching and privacy", evidence: "Provider-independent voice pipeline and privacy requirements present" },
  { id: "SAI-08", name: "Evaluation & Benchmarks", status: "Continuous", icon: Gauge, destination: "research/evaluation", use: "Factuality, coding, agents, Tamil, RAG, vision, document, latency and cost evaluation", evidence: "99-record nominal completion checkpoint followed by new benchmark updates" },
  { id: "SAI-09", name: "AI Security", status: "Reviewed", icon: ShieldCheck, destination: "research/security", use: "Prompt injection, RAG poisoning, MCP/tool risk, tenant isolation and least privilege", evidence: "Defensive intelligence only; no offensive enablement" },
  { id: "SAI-CF", name: "Cloudflare Edge Architecture", status: "Reviewed", icon: BrainCircuit, destination: "research/cloudflare", use: "Workers, Workflows, Agents, Vectorize, D1, R2, KV, Durable Objects and Hyperdrive", evidence: "Architecture intelligence; deployment changes remain gated" },
];

export default function IntelligenceDashboard() {
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
              Owner-supplied Gemini scheduled-task output: 298 pages. The dashboard exposes where each research stream belongs without treating research claims as deployed capability or current provider truth.
            </p>
          </div>
          <Link href="/"><Button variant="outline"><ArrowLeft size={16} /> Workspace</Button></Link>
        </div>

        <div className="mb-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Card><CardContent className="pt-6"><div className="text-sm text-muted-foreground">Source corpus</div><div className="mt-1 text-3xl font-bold">298</div><div className="text-xs text-muted-foreground">pages supplied by owner</div></CardContent></Card>
          <Card><CardContent className="pt-6"><div className="text-sm text-muted-foreground">Mapped domains</div><div className="mt-1 text-3xl font-bold">8</div><div className="text-xs text-muted-foreground">research-to-product destinations</div></CardContent></Card>
          <Card><CardContent className="pt-6"><div className="text-sm text-muted-foreground">Paid providers</div><div className="mt-1 text-3xl font-bold">0</div><div className="text-xs text-muted-foreground">approved for activation</div></CardContent></Card>
          <Card><CardContent className="pt-6"><div className="text-sm text-muted-foreground">Runtime truth</div><div className="mt-1 text-3xl font-bold">GATED</div><div className="text-xs text-muted-foreground">primary-source re-verification required</div></CardContent></Card>
        </div>

        <Card className="mb-8 border-amber-500/30">
          <CardContent className="flex gap-3 pt-6">
            <LockKeyhole className="mt-0.5 shrink-0" size={20} />
            <div><strong>Research is evidence, not production approval.</strong><p className="mt-1 text-sm leading-6 text-muted-foreground">Gemini findings can shape SakthiAI architecture, web UX, future mobile APIs, evaluation and security controls. Provider versions, pricing, licensing, privacy, limits and model claims must be re-verified from authoritative sources before runtime use.</p></div>
          </CardContent>
        </Card>

        <div className="grid gap-5 lg:grid-cols-2">
          {domains.map((domain) => {
            const Icon = domain.icon;
            return <Card key={domain.id} className="overflow-hidden">
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex gap-3"><div className="rounded-xl border p-2.5"><Icon size={20} /></div><div><div className="text-xs font-semibold tracking-wider text-muted-foreground">{domain.id}</div><CardTitle className="mt-1 text-xl">{domain.name}</CardTitle></div></div>
                  <Badge variant="outline">{domain.status}</Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm leading-6 text-muted-foreground">{domain.use}</p>
                <div className="rounded-lg bg-muted/45 p-3 text-sm"><div className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Repository destination</div><code>{domain.destination}</code></div>
                <div className="flex gap-2 text-sm"><CheckCircle2 className="mt-0.5 shrink-0" size={16} /><span>{domain.evidence}</span></div>
              </CardContent>
            </Card>;
          })}
        </div>

        <Card className="mt-8">
          <CardHeader><CardTitle>Promotion rules</CardTitle></CardHeader>
          <CardContent className="grid gap-3 text-sm md:grid-cols-2">
            <div className="rounded-lg border p-4"><strong>Website / dashboard</strong><p className="mt-1 text-muted-foreground">Expose capability taxonomy, verified status, evaluation/security posture and architecture decisions. Do not market research-only capabilities as live.</p></div>
            <div className="rounded-lg border p-4"><strong>Server / runtime</strong><p className="mt-1 text-muted-foreground">Use provider-neutral adapters. Bind a provider only after current official API, pricing, license, privacy and safety verification.</p></div>
            <div className="rounded-lg border p-4"><strong>Mobile apps</strong><p className="mt-1 text-muted-foreground">Reuse shared server capability contracts and local-model profiles. Avoid separate vendor-specific mobile architecture.</p></div>
            <div className="rounded-lg border p-4"><strong>CI / governance</strong><p className="mt-1 text-muted-foreground">Stable IDs, provenance, verification state, consent-sensitive media, tenant isolation and provider approval must remain machine-checkable gates.</p></div>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
