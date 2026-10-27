/** Pure presentation helpers for the Sentinel UI. No React, no DOM: unit-tested from server/sentinel/clientHelpers.test.ts. */

export type Tone = "ok" | "warn" | "bad" | "info" | "live";
export const STATUS_META: Record<string, { label: string; tone: Tone; terminal: boolean }> = {
  QUEUED: { label: "Queued", tone: "info", terminal: false },
  RUNNING: { label: "Investigating", tone: "live", terminal: false },
  COMPLETED: { label: "Diagnosis reached", tone: "ok", terminal: true },
  ABSTAINED: { label: "No conclusion", tone: "warn", terminal: true },
  FAILED: { label: "Failed", tone: "bad", terminal: true },
  CANCELLED: { label: "Cancelled", tone: "warn", terminal: true },
};
export const statusMeta = (s: string) => STATUS_META[s] ?? { label: s, tone: "info" as Tone, terminal: false };

export const TONE_CLASS: Record<Tone, string> = {
  ok: "border-emerald-200 bg-emerald-50 text-emerald-900",
  warn: "border-amber-200 bg-amber-50 text-amber-900",
  bad: "border-red-200 bg-red-50 text-red-900",
  info: "border-slate-200 bg-slate-50 text-slate-800",
  live: "border-lime-300 bg-lime-100 text-[#173b2e]",
};
export const SEVERITY_TONE: Record<string, Tone> = { low: "info", medium: "warn", high: "bad", critical: "bad" };

/** "DISK_FULL" -> "Disk full" */
export const humanLabel = (label: string): string => {
  const t = label.toLowerCase().replace(/_/g, " ").trim();
  return t ? t[0]!.toUpperCase() + t.slice(1) : label;
};

export const formatDuration = (ms: number): string => {
  if (!Number.isFinite(ms) || ms < 0) return "–";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${Math.round(s - m * 60)} s`;
};

export const confidencePct = (c: number | null | undefined): string => (typeof c === "number" && Number.isFinite(c) ? `${Math.round(Math.min(1, Math.max(0, c)) * 100)}%` : "–");

export const formatTime = (iso: string | null | undefined): string => {
  if (!iso) return "–";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" });
};

export const relativeTime = (iso: string | null | undefined, now: number = Date.now()): string => {
  if (!iso) return "–";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const s = Math.round((now - t) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
};

export const shortHash = (h: string | null | undefined): string => (h ? `${h.slice(0, 8)}…${h.slice(-6)}` : "–");

export const splitList = (text: string): string[] => [...new Set(text.split(/[\n,]/).map((x) => x.trim()).filter(Boolean))];

/* ---------------- diagnostic binding drafts (incident creation form) ---------------- */

export const READ_TOOL_HINTS: Record<string, { title: string; hint: RegExp; defaultTarget: string }> = {
  "logs.search": { title: "Logs", hint: /log|search/i, defaultTarget: "service" },
  "metrics.query": { title: "Metrics", hint: /metric|prom|query|series/i, defaultTarget: "service" },
  "deploys.list": { title: "Deployments", hint: /deploy|release|rollout/i, defaultTarget: "service" },
  "config.get": { title: "Configuration", hint: /config|setting|param/i, defaultTarget: "service" },
  "health.check": { title: "Health", hint: /health|status|probe|ping/i, defaultTarget: "service" },
  "runbook.lookup": { title: "Runbooks", hint: /runbook|playbook|doc|wiki/i, defaultTarget: "topic" },
  "tickets.search": { title: "Tickets", hint: /ticket|issue|incident/i, defaultTarget: "service" },
};
const MUTATING = /(^|[._-])(set|write|create|delete|remove|update|restart|reboot|rollback|revoke|failover|apply|exec|run|kill|stop|start|disable|enable|put|post|patch)([._-]|$)/i;

export interface BindingDraft { tool: string; connectorId: string; mcpTool: string; targetParam: string; queryParam: string; windowParam: string }
export const emptyDraft = (tool = ""): BindingDraft => ({ tool, connectorId: "", mcpTool: "", targetParam: READ_TOOL_HINTS[tool]?.defaultTarget ?? "service", queryParam: "", windowParam: "" });

/** Best guess of which discovered MCP tool serves a Sentinel read tool. Never suggests a mutating-looking name; the user still confirms. */
export const suggestMcpTool = (tool: string, mcpTools: readonly string[]): string => {
  const hint = READ_TOOL_HINTS[tool]?.hint;
  if (!hint) return "";
  return mcpTools.find((n) => hint.test(n) && !MUTATING.test(n)) ?? "";
};

const PARAM = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
export function validateDrafts(drafts: readonly BindingDraft[]): string[] {
  const errs: string[] = [];
  if (!drafts.length) errs.push("Add at least one read-only diagnostic tool.");
  const seen = new Set<string>();
  drafts.forEach((d, i) => {
    const n = `Tool ${i + 1}`;
    if (!d.tool) errs.push(`${n}: choose what it provides (logs, metrics, …).`);
    else if (seen.has(d.tool)) errs.push(`${n}: ${d.tool} is already bound.`); else seen.add(d.tool);
    if (!d.connectorId) errs.push(`${n}: choose a connector.`);
    if (!d.mcpTool) errs.push(`${n}: choose the connector tool to call.`);
    else if (MUTATING.test(d.mcpTool)) errs.push(`${n}: “${d.mcpTool}” looks like a mutating tool and cannot be used.`);
    if (!PARAM.test(d.targetParam)) errs.push(`${n}: the target argument name is not valid.`);
    for (const [label, v] of [["query", d.queryParam], ["window", d.windowParam]] as const) if (v && !PARAM.test(v)) errs.push(`${n}: the ${label} argument name is not valid.`);
  });
  return errs;
}
export const draftToBinding = (d: BindingDraft) => ({
  tool: d.tool as "logs.search", connectorId: d.connectorId, mcpTool: d.mcpTool, targetParam: d.targetParam.trim(),
  ...(d.queryParam.trim() ? { queryParam: d.queryParam.trim() } : {}), ...(d.windowParam.trim() ? { windowParam: d.windowParam.trim() } : {}),
});

/** Name used in the UI for an engine evidence id such as "o-1a2b#3". */
export const evidenceAnchor = (rid: string): string => `ev-${rid}`;

/* ---------------- runtime / connector presentation ---------------- */

export interface ModelReadiness { state: string; configuredProviders: number; eligibleProviders: number; operational: "verified" | "unverified" }
/** Truthful model-provider status. "Configured" is never presented as "working": only a real successful call or probe makes it verified. */
export function modelStatus(m: ModelReadiness | null | undefined): { label: string; tone: Tone; blocksStart: boolean; detail: string } {
  if (!m) return { label: "Unknown", tone: "info", blocksStart: false, detail: "The model provider status could not be read." };
  switch (m.state) {
    case "no_provider_configured": return { label: "No model provider", tone: "bad", blocksStart: true, detail: "No model provider is configured for this deployment, so investigations cannot run." };
    case "not_permitted_by_policy": return { label: "Blocked by policy", tone: "bad", blocksStart: true, detail: "Model policy does not permit any configured provider." };
    case "default_budget_denies_metered": return { label: "Budget not set", tone: "warn", blocksStart: false, detail: "Only metered providers are configured and the default budget denies them; a per-workspace budget may still allow it." };
    case "eligible": return m.operational === "verified"
      ? { label: "Provider verified", tone: "ok", blocksStart: false, detail: `${m.eligibleProviders} of ${m.configuredProviders} configured provider(s) eligible; one has answered successfully.` }
      : { label: "Configured, not yet verified", tone: "info", blocksStart: false, detail: `${m.eligibleProviders} of ${m.configuredProviders} configured provider(s) eligible. None has answered a request yet, so reachability is unconfirmed.` };
    default: return { label: m.state, tone: "info", blocksStart: false, detail: "" };
  }
}

export const LOCALITY_SHORT: Record<string, string> = { local: "Synthetic · loopback", "private-network": "Private network", remote: "Remote · not verified" };
export const LOCALITY_TONE: Record<string, Tone> = { local: "warn", "private-network": "info", remote: "info" };

export interface Discovered { connectorId: string; connectorName: string; tools: readonly string[] }
/** Which discovered read-only MCP tool could serve each Sentinel read tool. Suggestions only: the owner still binds explicitly. */
export function toolCoverage(readTools: readonly string[], found: readonly Discovered[]): Array<{ tool: string; connectorName: string | null; mcpTool: string | null }> {
  return readTools.map((tool) => {
    for (const d of found) { const m = suggestMcpTool(tool, d.tools); if (m) return { tool, connectorName: d.connectorName, mcpTool: m }; }
    return { tool, connectorName: null, mcpTool: null };
  });
}

export const OUTCOME_TONE: Record<string, Tone> = { OK: "ok", DENIED: "bad", ERROR: "bad", TIMEOUT: "warn", TOO_LARGE: "warn", INVALID: "warn" };

/** Mirrors the server's registration rules so the form can say what is wrong before a round trip. The server remains the authority. */
export function validateRegistration(f: { name: string; endpoint: string; secretRef: string; timeoutMs: string; maxResponseBytes: string }, approvedOrigins: readonly string[]): string[] {
  const errs: string[] = [];
  if (!/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,95}$/.test(f.name.trim())) errs.push("Name must start with a letter or digit and use only letters, digits, spaces, . _ - (max 96).");
  let origin = "";
  try { const u = new URL(f.endpoint.trim()); origin = u.origin; if (u.username || u.password) errs.push("The endpoint must not contain credentials."); if (u.search || u.hash) errs.push("The endpoint must not contain a query string or fragment."); }
  catch { errs.push("Enter the full endpoint URL, for example https://host/mcp."); }
  if (origin && !approvedOrigins.includes(origin)) errs.push(`${origin} is not an operator-approved endpoint. Only approved origins can be registered.`);
  if (f.secretRef && !/^[A-Z][A-Z0-9_]{0,63}$/.test(f.secretRef)) errs.push("The credential must be a reference name such as MY_SERVER_TOKEN, never a secret value.");
  for (const [label, v, lo, hi] of [["Timeout", f.timeoutMs, 500, 30_000], ["Max response size", f.maxResponseBytes, 1024, 2_000_000]] as const) {
    if (v && (!/^\d+$/.test(v) || Number(v) < lo || Number(v) > hi)) errs.push(`${label} must be a whole number between ${lo} and ${hi}.`);
  }
  return errs;
}

export interface ModelIdentity { status: "REPORTED" | "PARTIAL" | "UNVERIFIED"; decisions: number; identified: number; models: ReadonlyArray<{ providerId: string; modelId: string; profileId: string; providerKind: string; billingMode: string; configSource: string; decisions: number }>; note: string }
/** Compact, truthful "which model answered" text. UNVERIFIED is shown as such, never replaced by the configured default. */
export function modelIdentityText(m: ModelIdentity | null | undefined, started: boolean): { text: string; tone: Tone; detail: string } {
  if (!m || m.status === "UNVERIFIED") return { text: started ? "UNVERIFIED" : "Not run yet", tone: started ? "warn" : "info", detail: m?.note ?? "No model identity has been recorded." };
  const names = m.models.map((x) => `${x.modelId} via ${x.providerId}`).join(", ");
  return { text: m.status === "PARTIAL" ? `${names} (partial: ${m.decisions - m.identified} decision(s) unverified)` : names, tone: m.status === "PARTIAL" ? "warn" : "ok", detail: m.note };
}
