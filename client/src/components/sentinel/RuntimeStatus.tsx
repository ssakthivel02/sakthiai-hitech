import { Cpu, Plug, ServerCog, ToggleRight } from "lucide-react";
import { ToneBadge } from "./StatusBadge";
import { modelStatus, type ModelReadiness, type Tone } from "./format";

interface Props {
  enabled: boolean; workerEnabled: boolean; model: ModelReadiness | null | undefined;
  connectors: { enabled: number; total: number; syntheticEnabled: number } | undefined;
}

/** What this deployment can actually do right now. Nothing here is aspirational: each chip reflects a server-reported fact. */
export function RuntimeStatus({ enabled, workerEnabled, model, connectors }: Props) {
  const m = modelStatus(model);
  const diag: { label: string; tone: Tone; detail: string } = !connectors
    ? { label: "Connectors: checking…", tone: "info", detail: "" }
    : connectors.enabled === 0
      ? { label: "No enabled connector", tone: "bad", detail: "Sentinel cannot gather evidence without at least one enabled read-only connector." }
      : connectors.syntheticEnabled === connectors.enabled
        ? { label: `${connectors.enabled} connector(s) · all synthetic`, tone: "warn", detail: "Every enabled connector is a loopback/synthetic endpoint. Results are not from production monitoring systems." }
        : { label: `${connectors.enabled} of ${connectors.total} connector(s) enabled`, tone: "ok", detail: "Remote endpoints are not verified as production monitoring systems." };
  const items: Array<{ icon: typeof Cpu; title: string; label: string; tone: Tone; detail: string }> = [
    { icon: ToggleRight, title: "Feature", label: enabled ? "Enabled" : "Disabled", tone: enabled ? "ok" : "warn", detail: enabled ? "SENTINEL_ENABLED is on." : "SENTINEL_ENABLED is off (default)." },
    { icon: ServerCog, title: "Task worker", label: workerEnabled ? "Running" : "Off", tone: workerEnabled ? "ok" : "bad", detail: workerEnabled ? "Queued investigations are picked up." : "Queued investigations will not run." },
    { icon: Cpu, title: "Model provider", label: m.label, tone: m.tone, detail: m.detail },
    { icon: Plug, title: "Diagnostics", label: diag.label, tone: diag.tone, detail: diag.detail },
  ];
  return (
    <ul aria-label="Runtime status" className="mb-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
      {items.map(({ icon: Icon, title, label, tone, detail }) => (
        <li key={title} className="rounded-xl border border-[var(--line)] bg-white p-3">
          <div className="flex items-center gap-2 text-xs font-semibold text-[var(--muted)]"><Icon className="size-4" aria-hidden /> {title}</div>
          <div className="mt-1.5"><ToneBadge tone={tone}>{label}</ToneBadge></div>
          {detail && <p className="mt-1.5 text-xs text-[var(--muted)]">{detail}</p>}
        </li>
      ))}
    </ul>
  );
}
