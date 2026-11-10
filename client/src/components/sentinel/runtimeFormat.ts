import type { Tone } from "./format";

/** Structural subset of the server's RuntimeSnapshot that the panel needs. Kept loose so the UI never trusts shape. */
export interface RuntimeProvider { providerId: string; kind: string; runtimeClass: "local" | "hosted"; billingMode: string; state: string; breaker: string; modelId?: string; endpointProfile?: string; invalidReason?: string; eligibleForWorkspace: boolean; lastFailureClass?: string }

const STATE_TEXT: Record<string, { label: string; tone: Tone }> = {
  disabled: { label: "Not configured", tone: "info" },
  invalid_configuration: { label: "Configuration refused", tone: "bad" },
  configured_unverified: { label: "Configured, not yet verified", tone: "warn" },
  reachable_compatible: { label: "Answered a real call", tone: "ok" },
  unhealthy: { label: "Unhealthy", tone: "bad" },
};

/** One truthful line per provider. "Configured" is never shown as "working": only a real call earns the ok tone. */
export function providerLine(p: RuntimeProvider): { title: string; state: string; tone: Tone; detail: string } {
  const s = STATE_TEXT[p.state] ?? { label: p.state, tone: "info" as Tone };
  const where = p.runtimeClass === "local" ? "Local / self-hosted" : "Hosted (third party)";
  const parts = [where, p.billingMode === "metered_api" ? "pay-per-use" : p.billingMode === "subscription" ? "subscription" : "no per-call charge"];
  if (p.modelId) parts.push(`model ${p.modelId}`);
  if (p.endpointProfile) parts.push(`endpoint profile ${p.endpointProfile}`);
  const notes: string[] = [];
  if (p.invalidReason) notes.push(`Refused: ${p.invalidReason}.`);
  if (p.state !== "disabled" && p.state !== "invalid_configuration") notes.push(p.eligibleForWorkspace ? "Allowed for this workspace." : "Not allowed for this workspace by policy: no calls are sent.");
  if (p.breaker !== "CLOSED") notes.push(`Circuit breaker ${p.breaker.toLowerCase().replace("_", "-")}.`);
  if (p.lastFailureClass) notes.push(`Last failure: ${p.lastFailureClass.replace(/_/g, " ")}.`);
  return { title: p.runtimeClass === "local" ? "Local model" : "External model", state: s.label, tone: s.tone, detail: `${parts.join(" · ")}. ${notes.join(" ")}`.trim() };
}

/** Amounts are estimates (configured rate x provider-reported tokens) and are labelled so wherever they appear. */
export function budgetLine(label: string, used: number | null | undefined, limit: number | null | undefined, remaining: number | null | undefined, unit = ""): string {
  if (limit === null || limit === undefined) return `${label}: no limit set`;
  const u = (n: number) => `${Number.isInteger(n) ? n : n.toFixed(2)}${unit ? ` ${unit}` : ""}`;
  return `${label}: ${used === null || used === undefined ? "usage unknown" : `${u(used)} used`} of ${u(limit)}${remaining === null || remaining === undefined ? "" : ` (${u(remaining)} left)`}`;
}

export function recentLine(r: { status: string; reason?: string; providerId?: string; modelId?: string; fellBack: boolean; latencyMs: number }): string {
  if (r.status === "failed") return `Refused or failed: ${(r.reason ?? "unknown").replace(/_/g, " ")}`;
  return `Answered by ${r.modelId ?? r.providerId ?? "unknown"}${r.fellBack ? " after another provider was tried or skipped" : ""} in ${r.latencyMs} ms`;
}
