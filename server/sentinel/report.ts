import type { Hypothesis } from "./engine/types";
import type { EvidenceView, InvestigationView, ModelIdentityView } from "./view";

/** Exported report: built only from a view (i.e. from persisted events). Always states what Sentinel did NOT do. */
export interface InvestigationReport {
  schema: "sakthiai.sentinel.report/2";
  generatedAt: string;
  state: "COMPLETE" | "PARTIAL";
  investigation: { id: string; title: string; severity: string; service: string; firedAt: string; status: string; stopReason: string | null; objective: string; description: string };
  conclusion: null | { outcome: string; label: string; confidence: number; summary: string; abstainReason: string | null };
  hypotheses: Hypothesis[];
  timestamps: { alertFiredAt: string; createdAt: string; startedAt: string | null; finishedAt: string | null };
  /** What ran the model. Provider and model names are chosen by the Provider Gateway and are NOT exposed to the task interface, so they are not recorded here. */
  runtime: { modelTransport: string | null; modelCalls: number; resumes: number; providerIdentityCaptured: boolean; modelIdentity: ModelIdentityView; note: string };
  hypothesisHistory: Array<{ step: number; hypotheses: Hypothesis[] }>;
  citations: Array<Pick<EvidenceView, "rid" | "tool" | "target" | "ts" | "level" | "text"> & { source: string | null; step: number }>;
  contradictions: Array<[string | null, string | null]>;
  toolActivity: Array<{ step: number; tool: string; target: string; status: string; records: number; quarantined: number; durationMs: number; denyReason: string | null; source: string | null; replayed: boolean }>;
  remediation: null | { proposal: string; status: "PROPOSED_NOT_EXECUTED"; requiresApproval: true; executed: false; approval: "NONE_RECORDED" };
  /** API-level lifecycle audit (who created / cancelled / exported). Execution itself is evidenced by the hash-chained trace and the connector audit log. */
  audit: Array<{ action: string; actorUserId: number; detail: string | null; createdAt: string }>;
  nextSafeSteps: string[];
  verification: null | { passed: boolean; note: string; rejectedChecks: string[]; ledgerWarnings: string[] };
  integrity: { chainOk: boolean; complete: boolean; head: string | null; eventCount: number };
  disclosures: string[];
}

export const REPORT_DISCLOSURES = [
  "Sentinel is read-only. It has no write capability and executed no remediation; any remediation shown is a proposal that requires human approval.",
  "The conclusion is an AI-generated hypothesis supported by the cited records. 'Verified' means structural evidence checks passed, not that the root cause is proven.",
  "Only the cited records support the conclusion; other collected records are listed in the tool activity but are not asserted as causes.",
  "Evidence text is untrusted output from diagnostic systems and is shown as data; instruction-like text is quarantined before any model sees it.",
];

export const RUNTIME_NOTE = "Model calls go through the SakthiAI Provider Gateway. Provider/model identity is recorded only when the gateway reported it for the call; otherwise it is UNVERIFIED. No credentials, endpoints or prompts are recorded; prompt and response hashes are in the trace.";

/** One honest line describing which model answered. UNVERIFIED is stated, never replaced by a guess. */
export function describeModelIdentity(m: ModelIdentityView): string {
  if (m.status === "UNVERIFIED") return "Model identity: UNVERIFIED (not recorded for this investigation)";
  const list = m.models.map((x) => `${x.providerId} / ${x.modelId} (profile ${x.profileId}, ${x.runtimeClass ? `${x.runtimeClass}, ` : ""}${x.providerKind}, ${x.billingMode}${x.endpointProfile ? `, endpoint profile ${x.endpointProfile}` : ""}, configured via ${x.configSource}; ${x.decisions} decision${x.decisions === 1 ? "" : "s"})`).join("; ");
  const extra = `${m.fallbackDecisions ? `; ${m.fallbackDecisions} decision(s) answered after another candidate was tried or skipped` : ""}${m.cost ? `; gateway-computed cost ${m.cost.amount} ${m.cost.unit} (configured rate x reported tokens${m.cost.estimated ? ", estimated" : ""}; not an invoice)` : ""}`;
  return `Model identity: ${m.status === "PARTIAL" ? "PARTIAL - " : ""}${list}${m.status === "PARTIAL" ? `; ${m.decisions - m.identified} decision(s) UNVERIFIED` : ""}${extra}`;
}
export type ReportAudit = Array<{ action: string; actorUserId: number; detail: string | null; createdAt: string }>;

/** Filename-safe stem: lowercase ascii slug of the title plus the id prefix. Never contains path separators, dots or control characters. */
export function reportStem(title: string, id: string): string {
  const slug = title.normalize("NFKD").replace(/[^\x00-\x7F]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/g, "");
  return `sentinel-${slug ? slug + "-" : ""}${id.replace(/[^a-f0-9]/gi, "").slice(0, 8)}`;
}

/** The engine transport class is "remote" for every SakthiAI Provider Gateway call regardless of where the provider runs, so it must not be read as locality. */
const transportLabel = (t: string): string => (t === "remote" ? "via provider gateway (provider location not captured)" : t);

export function buildReport(v: InvestigationView, now: Date = new Date(), audit: ReportAudit = []): InvestigationReport {
  const i = v.investigation;
  const sourceOf = new Map(v.toolCalls.map((t) => [t.index, t.sourceSystem]));
  const transports = [...new Set(v.decisions.map((d) => d.model?.transport).filter((x): x is string => !!x))];
  return {
    schema: "sakthiai.sentinel.report/2", generatedAt: now.toISOString(), state: v.integrity.complete && v.final ? "COMPLETE" : "PARTIAL",
    investigation: { id: i.id, title: i.title, severity: i.severity, service: i.service, firedAt: i.firedAt, status: i.status, stopReason: i.stopReason, objective: i.objective, description: i.description },
    conclusion: v.final ? { outcome: v.final.outcome, label: v.final.label, confidence: v.final.confidence, summary: v.final.summary, abstainReason: v.final.abstainReason } : null,
    timestamps: { alertFiredAt: i.firedAt, createdAt: i.createdAt, startedAt: i.startedAt, finishedAt: i.finishedAt },
    runtime: { modelTransport: transports.length ? transports.map(transportLabel).join(", ") : null, modelCalls: Math.max(0, ...v.decisions.map((d) => d.model?.modelCalls ?? 0)), resumes: v.progress.resumes, providerIdentityCaptured: v.modelIdentity.status !== "UNVERIFIED", modelIdentity: v.modelIdentity, note: RUNTIME_NOTE },
    hypotheses: v.hypotheses.latest,
    hypothesisHistory: v.hypotheses.history,
    citations: (v.final?.citations ?? []).map((c) => ({ rid: c.rid, tool: c.tool, target: c.target, ts: c.ts, level: c.level, text: c.text, source: sourceOf.get(c.callIndex) ?? null, step: c.step })),
    contradictions: (v.final?.contradictions ?? []).map(([a, b]) => [a?.rid ?? null, b?.rid ?? null]),
    toolActivity: v.toolCalls.map((t) => ({ step: t.step, tool: t.tool, target: t.target, status: t.status, records: t.recordCount, quarantined: t.quarantinedCount, durationMs: t.durationMs, denyReason: t.denyReason, source: t.sourceSystem, replayed: t.replayed })),
    remediation: v.final ? { proposal: v.final.remediation.text, status: v.final.remediation.status, requiresApproval: true, executed: false, approval: "NONE_RECORDED" as const } : null,
    audit: audit.slice(0, 50).map((a) => ({ action: a.action, actorUserId: a.actorUserId, detail: a.detail, createdAt: a.createdAt })),
    nextSafeSteps: v.final?.nextSafeSteps ?? [],
    verification: v.verification ? { passed: v.verification.passed, note: v.verification.note, rejectedChecks: v.verification.rejectedChecks, ledgerWarnings: v.verification.ledgerWarnings } : null,
    integrity: { chainOk: v.integrity.chainOk, complete: v.integrity.complete, head: v.integrity.head, eventCount: v.integrity.eventCount },
    disclosures: REPORT_DISCLOSURES,
  };
}

/** Fence with more backticks than any run inside the text, so evidence can never break out of its block. */
const fence = (text: string): string => {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((m) => m.length));
  const f = "`".repeat(longest + 1);
  return `${f}\n${text.replace(/\r/g, "")}\n${f}`;
};
const cell = (s: string): string => s.replace(/[|\r\n]+/g, " ").replace(/`/g, "'");

export function renderMarkdown(r: InvestigationReport): string {
  const L: string[] = [];
  L.push(`# Sentinel investigation report`, "", `**${cell(r.investigation.title)}**`, "");
  L.push(`- Investigation: \`${r.investigation.id}\``, `- Service: ${cell(r.investigation.service)} · Severity: ${r.investigation.severity} · Alert fired: ${cell(r.investigation.firedAt)}`);
  L.push(`- Status: **${r.investigation.status}**${r.investigation.stopReason ? ` (${cell(r.investigation.stopReason)})` : ""} · Report state: ${r.state} · Generated: ${r.generatedAt}`, "");
  L.push(`- Alert fired: ${cell(r.timestamps.alertFiredAt)} · Created: ${r.timestamps.createdAt} · Started: ${r.timestamps.startedAt ?? "-"} · Finished: ${r.timestamps.finishedAt ?? "-"}`);
  L.push(`- Runtime: model transport ${cell(r.runtime.modelTransport ?? "none recorded")} · model calls ${r.runtime.modelCalls} · resumes ${r.runtime.resumes}`, `- ${cell(describeModelIdentity(r.runtime.modelIdentity))}`, ...(r.runtime.modelIdentity.tokens ? [`- Gateway-reported tokens: ${r.runtime.modelIdentity.tokens.prompt} prompt / ${r.runtime.modelIdentity.tokens.completion} completion (${r.runtime.modelIdentity.tokens.decisionsCounted} decision(s) counted)`] : []), `- ${r.runtime.note}`, "");
  L.push(`## Conclusion`, "");
  if (r.conclusion) {
    L.push(`**${r.conclusion.outcome === "DIAGNOSIS" ? `Diagnosis: ${cell(r.conclusion.label)}` : "No conclusion drawn (abstained)"}** · confidence ${(r.conclusion.confidence * 100).toFixed(0)}% (model-stated, uncalibrated)`, "");
    L.push(fence(r.conclusion.summary), "");
    if (r.conclusion.abstainReason) L.push(`Abstain reason: ${cell(r.conclusion.abstainReason)}`, "");
  } else L.push("_No conclusion has been recorded yet._", "");
  if (r.hypotheses.length) {
    L.push(`## Hypotheses (latest)`, "", `| Label | Score | Status | Supporting records |`, `|---|---|---|---|`);
    for (const h of r.hypotheses) L.push(`| ${cell(h.label)} | ${h.score.toFixed(2)} | ${h.status} | ${cell(h.supporting.join(", ") || "-")} |`);
    L.push("");
  }
  if (r.hypothesisHistory.length > 1) {
    L.push(`## Hypothesis revisions`, "", `| Step | Hypotheses (label score status) |`, `|---|---|`);
    for (const h of r.hypothesisHistory) L.push(`| ${h.step} | ${cell(h.hypotheses.map((x) => `${x.label} ${x.score.toFixed(2)} ${x.status}`).join("; ") || "-")} |`);
    L.push("");
  }
  if (r.citations.length) {
    L.push(`## Cited evidence`, "");
    for (const c of r.citations) L.push(`**${cell(c.rid)}** — ${cell(c.tool)} on ${cell(c.target)} · ${cell(c.ts)} · ${cell(c.level)} · source ${cell(c.source ?? "unknown")} · step ${c.step}`, "", fence(c.text), "");
  }
  if (r.contradictions.length) { L.push(`## Contradictions`, ""); for (const [a, b] of r.contradictions) L.push(`- ${cell(a ?? "?")} ↔ ${cell(b ?? "?")}`); L.push(""); }
  L.push(`## Diagnostic tool activity`, "");
  if (r.toolActivity.length) {
    L.push(`| Step | Tool | Target | Source | Status | Records | Quarantined | ms |`, `|---|---|---|---|---|---|---|---|`);
    for (const t of r.toolActivity) L.push(`| ${t.step} | ${cell(t.tool)} | ${cell(t.target)} | ${cell(t.source ?? "-")} | ${t.status}${t.denyReason ? ` (${cell(t.denyReason)})` : ""}${t.replayed ? " (replayed)" : ""} | ${t.records} | ${t.quarantined} | ${t.durationMs} |`);
  } else L.push("_No diagnostic tool was called._");
  L.push("");
  if (r.remediation) { L.push(`## Proposed remediation (NOT executed — requires human approval)`, "", `Approval status: ${r.remediation.approval} · executed: no`, "", fence(r.remediation.proposal), ""); }
  if (r.nextSafeSteps.length) { L.push(`## Next safe steps`, ""); for (const s of r.nextSafeSteps) L.push(`- ${cell(s)}`); L.push(""); }
  if (r.verification) {
    L.push(`## Verification`, "", `- Structural checks: **${r.verification.passed ? "passed" : "failed"}**`, `- ${r.verification.note}`);
    if (r.verification.rejectedChecks.length) L.push(`- Rejected checks: ${r.verification.rejectedChecks.map(cell).join("; ")}`);
    if (r.verification.ledgerWarnings.length) L.push(`- Ledger warnings: ${r.verification.ledgerWarnings.map(cell).join("; ")}`);
    L.push("");
  }
  if (r.audit.length) { L.push(`## Activity audit`, ""); for (const a of r.audit) L.push(`- ${a.createdAt} · ${cell(a.action)} · user #${a.actorUserId}${a.detail ? ` · ${cell(a.detail)}` : ""}`); L.push(""); }
  L.push(`## Integrity`, "", `- Event chain: ${r.integrity.chainOk ? "intact" : "BROKEN"} · complete trace: ${r.integrity.complete ? "yes" : "no"} · events: ${r.integrity.eventCount}`, `- Trace head: \`${r.integrity.head ?? "none"}\``, "");
  L.push(`## Disclosures`, ""); for (const d of r.disclosures) L.push(`- ${d}`);
  return L.join("\n") + "\n";
}

const esc = (t: unknown): string => String(t ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/**
 * Self-contained printable report. Every value is HTML-escaped and the page carries a CSP that forbids scripts, network and frames, so evidence
 * text (untrusted output from diagnostic systems) can never execute even if it contains markup.
 */
export function renderHtml(r: InvestigationReport): string {
  const table = (head: string[], rows: string[][]) => `<table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  const c = r.conclusion;
  const parts: string[] = [];
  parts.push(`<h1>Sentinel investigation report</h1><p class="sub">${esc(r.investigation.title)}</p>`);
  parts.push(`<dl><dt>Investigation</dt><dd class="mono">${esc(r.investigation.id)}</dd><dt>Service / severity</dt><dd>${esc(r.investigation.service)} · ${esc(r.investigation.severity)}</dd><dt>Status</dt><dd>${esc(r.investigation.status)}${r.investigation.stopReason ? ` (${esc(r.investigation.stopReason)})` : ""} · report ${esc(r.state)}</dd><dt>Timeline</dt><dd>alert ${esc(r.timestamps.alertFiredAt)} · created ${esc(r.timestamps.createdAt)} · started ${esc(r.timestamps.startedAt ?? "-")} · finished ${esc(r.timestamps.finishedAt ?? "-")}</dd><dt>Runtime</dt><dd>${esc(r.runtime.modelTransport ?? "none recorded")} · ${r.runtime.modelCalls} model call(s) · ${r.runtime.resumes} resume(s)<br>${esc(describeModelIdentity(r.runtime.modelIdentity))}<br><small>${esc(r.runtime.note)}</small></dd><dt>Generated</dt><dd>${esc(r.generatedAt)}</dd></dl>`);
  parts.push(`<h2>Conclusion</h2>` + (c ? `<p><strong>${c.outcome === "DIAGNOSIS" ? `Diagnosis: ${esc(c.label)}` : "No conclusion drawn (abstained)"}</strong> · confidence ${(c.confidence * 100).toFixed(0)}% (model-stated, uncalibrated)</p><pre>${esc(c.summary)}</pre>${c.abstainReason ? `<p>Abstain reason: ${esc(c.abstainReason)}</p>` : ""}` : `<p><em>No conclusion has been recorded yet.</em></p>`));
  if (r.hypotheses.length) parts.push(`<h2>Hypotheses (latest)</h2>` + table(["Label", "Score", "Status", "Supporting records"], r.hypotheses.map((h) => [h.label, h.score.toFixed(2), h.status, h.supporting.join(", ") || "-"])));
  if (r.hypothesisHistory.length > 1) parts.push(`<h2>Hypothesis revisions</h2>` + table(["Step", "Hypotheses"], r.hypothesisHistory.map((h) => [String(h.step), h.hypotheses.map((x) => `${x.label} ${x.score.toFixed(2)} ${x.status}`).join("; ") || "-"])));
  if (r.citations.length) parts.push(`<h2>Cited evidence</h2>` + r.citations.map((x) => `<div class="ev"><div class="mono">${esc(x.rid)}</div><div>${esc(x.tool)} on ${esc(x.target)} · ${esc(x.ts)} · ${esc(x.level)} · source ${esc(x.source ?? "unknown")} · step ${x.step}</div><pre>${esc(x.text)}</pre></div>`).join(""));
  if (r.contradictions.length) parts.push(`<h2>Contradictions</h2><ul>${r.contradictions.map(([a, b]) => `<li>${esc(a ?? "?")} ↔ ${esc(b ?? "?")}</li>`).join("")}</ul>`);
  parts.push(`<h2>Diagnostic tool activity</h2>` + (r.toolActivity.length ? table(["Step", "Tool", "Target", "Source", "Status", "Records", "Quarantined", "ms"], r.toolActivity.map((t) => [String(t.step), t.tool, t.target, t.source ?? "-", `${t.status}${t.denyReason ? ` (${t.denyReason})` : ""}${t.replayed ? " (replayed)" : ""}`, String(t.records), String(t.quarantined), String(t.durationMs)])) : `<p><em>No diagnostic tool was called.</em></p>`));
  if (r.remediation) parts.push(`<h2>Proposed remediation <span class="tag">NOT executed · requires human approval</span></h2><p>Approval status: ${esc(r.remediation.approval)}</p><pre>${esc(r.remediation.proposal)}</pre>`);
  if (r.nextSafeSteps.length) parts.push(`<h2>Next safe steps</h2><ul>${r.nextSafeSteps.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`);
  if (r.verification) parts.push(`<h2>Verification</h2><p>Structural checks: <strong>${r.verification.passed ? "passed" : "failed"}</strong></p><p>${esc(r.verification.note)}</p>${r.verification.rejectedChecks.length ? `<p>Rejected checks: ${esc(r.verification.rejectedChecks.join("; "))}</p>` : ""}`);
  if (r.audit.length) parts.push(`<h2>Activity audit</h2>` + table(["Time", "Action", "User", "Detail"], r.audit.map((a) => [a.createdAt, a.action, `#${a.actorUserId}`, a.detail ?? ""])));
  parts.push(`<h2>Integrity</h2><p>Event chain ${r.integrity.chainOk ? "intact" : "BROKEN"} · complete trace ${r.integrity.complete ? "yes" : "no"} · ${r.integrity.eventCount} events<br><span class="mono">head ${esc(r.integrity.head ?? "none")}</span></p>`);
  parts.push(`<h2>Disclosures</h2><ul>${r.disclosures.map((d) => `<li>${esc(d)}</li>`).join("")}</ul>`);
  const css = "body{font:14px/1.5 system-ui,sans-serif;max-width:900px;margin:24px auto;padding:0 16px;color:#111}h1{font-size:24px;margin:0}h2{font-size:16px;margin:24px 0 8px;border-bottom:1px solid #ccc;padding-bottom:4px}.sub{font-size:18px;font-weight:600;margin:4px 0 16px}dl{display:grid;grid-template-columns:150px 1fr;gap:4px 12px}dt{color:#555}dd{margin:0}.mono{font-family:ui-monospace,monospace;font-size:12px;word-break:break-all}pre{white-space:pre-wrap;word-break:break-word;background:#f6f6f6;border:1px solid #ddd;padding:8px;border-radius:6px;font-size:12px}table{border-collapse:collapse;width:100%;font-size:12px}th,td{border:1px solid #ccc;padding:4px 6px;text-align:left;vertical-align:top}.ev{margin:8px 0;page-break-inside:avoid}.tag{font-size:11px;background:#fff3cd;border:1px solid #e0c36a;padding:1px 6px;border-radius:10px;font-weight:600}small{color:#555}@media print{body{margin:0}}";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(r.investigation.title)} - Sentinel report</title><style>${css}</style></head><body>${parts.join("\n")}</body></html>\n`;
}
