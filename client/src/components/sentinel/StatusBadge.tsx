import { AlertTriangle, CheckCircle2, CircleSlash, Clock3, Loader2, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { SEVERITY_TONE, TONE_CLASS, statusMeta, type Tone } from "./format";

const ICON: Record<string, typeof Clock3> = { QUEUED: Clock3, RUNNING: Loader2, COMPLETED: CheckCircle2, ABSTAINED: CircleSlash, FAILED: XCircle, CANCELLED: AlertTriangle };

export function ToneBadge({ tone, children, className }: { tone: Tone; children: React.ReactNode; className?: string }) {
  return <Badge variant="outline" className={cn("gap-1 font-medium", TONE_CLASS[tone], className)}>{children}</Badge>;
}

export function StatusBadge({ status }: { status: string }) {
  const m = statusMeta(status);
  const Icon = ICON[status] ?? Clock3;
  return <ToneBadge tone={m.tone}><Icon aria-hidden className={cn(status === "RUNNING" && "motion-safe:animate-spin")} />{m.label}</ToneBadge>;
}

export function SeverityBadge({ severity }: { severity: string }) {
  return <ToneBadge tone={SEVERITY_TONE[severity] ?? "info"} className="uppercase tracking-wide">{severity}</ToneBadge>;
}
