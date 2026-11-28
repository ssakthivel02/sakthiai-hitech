import type { CaseDoc, FinalAnswer } from "./types";
import { READ_TOOLS, WRITE_TOOLS } from "./types";
import type { EvidenceItem } from "./broker";
import { INJECTION_PATTERNS } from "./broker";
import { KB_BY_LABEL, matchedSigs, toolsOf } from "./kb";

export const VERIFICATION_POLICY_VERSION = "sentinel-evidence-2";
/** Conservative incident-relative window; source timestamps remain untrusted, not attested. */
export const DEFAULT_EVIDENCE_WINDOW = { lookbackMs: 86_400_000, lookaheadMs: 86_400_000, clockSkewMs: 300_000 } as const;
export interface VerifyOptions {
  /** Trusted server policy only; never supplied by the model. Historical event windows can be selected explicitly. */
  evidenceWindow?: { lookbackMs: number; lookaheadMs: number; clockSkewMs?: number; asOfMs?: number };
  requireSignatureSupport: boolean;
  /**
   * "off" skips the signature KB (kb.ts), which is built from synthetic dev fixtures and would reject valid diagnoses on real telemetry.
   * Production uses "off": schema, citation, independence (>=2 records from >=2 tools), false-claim and echo checks still run, but a verified
   * result then means "structurally evidence-backed", NOT "semantically proven correct". Default "enforce" keeps the prototype behaviour.
   */
  signatureKb?: "enforce" | "off";
}
export interface VerifyResult { ok: boolean; fatal: string[]; redactions: string[]; sanitized: FinalAnswer; support: { signals: number; tools: number } | null }

/** Phrases that claim an action HAS been taken. Sentinel has no write tools, so any such claim is false by construction. */
const ACT = "(?:restarted|rebooted|rolled back|fixed|resolved|applied|restored|disabled|terminated|killed|deployed|reverted|revoked|failed over|mitigated|cleaned(?: up)?|cleared|purged|deleted|removed|freed|renewed|rotated|reset|reconfigured|patched|updated|scaled|drained|rebuilt|recreated|re-?enabled|enabled|stopped|started|reloaded|flushed|resynced|synced|increased|raised|reordered|repointed|recovered|remediated|corrected|closed)";
export const FALSE_CLAIM_PATTERNS: RegExp[] = [
  new RegExp("\\b(i|we|sentinel)\\s+(?:have\\s+|had\\s+)?(?:successfully\\s+)?" + ACT + "\\b", "i"),
  new RegExp("\\b(?:has|have|had)\\s+been\\s+(?:successfully\\s+)?" + ACT + "\\b", "i"),
  new RegExp("\\b(?:was|were)\\s+(?:successfully\\s+)?" + ACT + "\\b", "i"),
  /\b\w+ed\s+successfully\b|\bsuccessfully\s+\w+ed\b/i,
  /\b(remediation|fix|rollback|restart|mitigation|cleanup)\s+(is\s+|was\s+)?(complete|completed|done|successful|applied)\b/i,
  /\b(incident|issue|alert|problem)\s+(is\s+|has been\s+)?(resolved|closed|mitigated)\b/i,
];
const FQDN = /\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)+\b/gi;

/** Conservative lexical guard, shared with bounded model correction. Not a semantic attribution exception. */
export function falseActionClaimLocations(final: FinalAnswer): string[] {
  const texts: Array<[string, string]> = [["summary", final.summary], ["remediation", final.remediation.text], ...final.next_safe_steps.map((s, i) => [`step${i}`, s] as [string, string]), ...(final.abstain_reason !== undefined ? [["abstain_reason", final.abstain_reason] as [string, string]] : [])];
  return texts.filter(([, text]) => FALSE_CLAIM_PATTERNS.some((p) => p.test(text))).map(([where]) => where);
}

export function verifyFinal(final: FinalAnswer, c: CaseDoc, evidence: Map<string, EvidenceItem>, taxonomy: Record<string, string>, opts: VerifyOptions): VerifyResult {
  const fatal: string[] = [], redactions: string[] = [];
  const sanitized: FinalAnswer = JSON.parse(JSON.stringify(final));
  // --- schema
  const str = (x: unknown, max: number) => typeof x === "string" && x.length <= max;
  if (final.outcome !== "DIAGNOSIS" && final.outcome !== "ABSTAIN") fatal.push("SCHEMA:outcome");
  if (!str(final.label, 60) || !Object.prototype.hasOwnProperty.call(taxonomy, final.label)) fatal.push("SCHEMA:label-not-in-taxonomy");
  if (final.outcome === "DIAGNOSIS" && final.label === "INCONCLUSIVE") fatal.push("SCHEMA:diagnosis-with-inconclusive-label");
  if (final.outcome === "ABSTAIN" && final.label !== "INCONCLUSIVE") fatal.push("SCHEMA:abstain-with-specific-label");
  if (!str(final.summary, 1500)) fatal.push("SCHEMA:summary");
  if (typeof final.confidence !== "number" || !Number.isFinite(final.confidence) || final.confidence < 0 || final.confidence > 1) fatal.push("SCHEMA:confidence");
  if (!Array.isArray(final.cited) || final.cited.some((x) => !str(x, 80))) fatal.push("SCHEMA:cited");
  if (!Array.isArray(final.contradictions) || final.contradictions.some((p) => !Array.isArray(p) || p.length !== 2 || p.some((x) => !str(x, 80)))) fatal.push("SCHEMA:contradictions");
  if (!final.remediation || !str(final.remediation.text, 1500)) fatal.push("SCHEMA:remediation");
  else if (final.remediation.executed !== false || final.remediation.requires_approval !== true) fatal.push("APPROVAL:remediation-must-be-unexecuted-and-require-approval");
  if (final.abstain_reason !== undefined && !str(final.abstain_reason, 200)) fatal.push("SCHEMA:abstain_reason");
  if (!Array.isArray(final.next_safe_steps) || final.next_safe_steps.some((x) => !str(x, 300))) fatal.push("SCHEMA:next_safe_steps");
  if (fatal.some((f) => f.startsWith("SCHEMA"))) return { ok: false, fatal, redactions, sanitized, support: null };
  // --- citations
  const cited = final.cited;
  for (const rid of cited) {
    const ev = evidence.get(rid);
    if (!ev) fatal.push(`CITATION:unknown-evidence:${rid}`);
    else if (ev.quarantined) fatal.push(`CITATION:quarantined-evidence:${rid}`);
  }
  for (const [a, b] of final.contradictions) for (const rid of [a, b]) {
    const ev = evidence.get(rid);
    if (!ev) fatal.push(`CONTRADICTION:unknown-evidence:${rid}`);
    else if (ev.quarantined) fatal.push(`CONTRADICTION:quarantined-evidence:${rid}`);
  }
  // Validate cited and contradiction records, not just the surface shape of a model's conclusion.
  const window = opts.evidenceWindow ?? DEFAULT_EVIDENCE_WINDOW;
  const asOf = "asOfMs" in window && window.asOfMs !== undefined ? window.asOfMs : Date.now();
  const skew = window.clockSkewMs ?? DEFAULT_EVIDENCE_WINDOW.clockSkewMs;
  const anchor = evidenceTime(c.alert.fired_at);
  if (![window.lookbackMs, window.lookaheadMs, skew, asOf].every((x) => typeof x === "number" && Number.isFinite(x) && x >= 0)) fatal.push("TEMPORAL:invalid-policy");
  for (const rid of new Set([...cited, ...final.contradictions.flat()])) {
    const ev = evidence.get(rid); if (!ev || ev.quarantined) continue;
    const at = evidenceTime(ev.ts);
    if (!Number.isFinite(anchor) || !Number.isFinite(at)) fatal.push(`TEMPORAL:invalid-timestamp:${rid}`);
    else if (at < anchor - window.lookbackMs) fatal.push(`TEMPORAL:outside-lookback:${rid}`);
    else if (at > anchor + window.lookaheadMs || at > asOf + skew) fatal.push(`TEMPORAL:future-evidence:${rid}`);
  }
  // --- independence + support for a diagnosis
  let support: VerifyResult["support"] = null;
  if (final.outcome === "DIAGNOSIS") {
    const items = cited.map((r) => evidence.get(r)).filter((x): x is EvidenceItem => !!x && !x.quarantined);
    const tools = new Set(items.map((i) => i.tool));
    const observations = new Set(items.map((i) => i.obs_id));
    if (observations.size < 2) fatal.push(`INDEPENDENCE:need>=2 distinct observations, got ${observations.size}`);
    if (items.length < 2 || tools.size < 2) fatal.push(`INDEPENDENCE:need>=2 citations from >=2 tools, got ${items.length}/${tools.size}`);
    const entry = opts.signatureKb === "off" ? undefined : KB_BY_LABEL.get(final.label);
    if (entry) {
      // evidence of every observation that has a cited record counts (a fact may sit on a neighbouring line of the same response)
      const obsIds = new Set(items.map((i) => i.obs_id));
      const pool = [...evidence.values()].filter((e) => obsIds.has(e.obs_id) && !e.quarantined);
      const m = matchedSigs(entry, pool, { firedAt: c.alert.fired_at });
      const t = toolsOf(m);
      support = { signals: m.size, tools: t.size };
      if (m.size < 2 || t.size < 2) fatal.push(`SUPPORT:cited evidence matches ${m.size} signature(s) from ${t.size} tool(s) for ${final.label}; need >=2 from >=2`);
    } else if (opts.requireSignatureSupport && opts.signatureKb !== "off") fatal.push(`SUPPORT:no signature knowledge for ${final.label}; cannot verify (strict mode)`);
  } else if (cited.length > 0 && cited.some((r) => !evidence.has(r))) fatal.push("CITATION:abstain-cites-unknown");
  // --- false remediation claims (fatal) over all free text
  for (const where of falseActionClaimLocations(final)) fatal.push(`CLAIM:false-remediation-claim in ${where}`);
  // --- echo guard (non-fatal, redacts): hostnames/URLs not present in the case, injection-like phrases
  const caseText = JSON.stringify(c).toLowerCase();
  const known = new Set<string>([...READ_TOOLS, ...WRITE_TOOLS].map((s) => s.toLowerCase()));
  const guard = (s: string, where: string): string => {
    let out = s.replace(/https?:\/\/\S+/gi, () => { redactions.push(`${where}:url`); return "[REDACTED-URL]"; });
    out = out.replace(FQDN, (m) => { const l = m.toLowerCase(); if (known.has(l) || caseText.includes(l)) return m; redactions.push(`${where}:entity`); return "[REDACTED-ENTITY]"; });
    for (const p of INJECTION_PATTERNS) if (p.re.test(out)) { redactions.push(`${where}:injection-phrase:${p.id}`); out = "[REDACTED-INSTRUCTION-LIKE-TEXT]"; break; }
    return out;
  };
  if (final.abstain_reason !== undefined) sanitized.abstain_reason = guard(final.abstain_reason, "abstain_reason");
  sanitized.summary = guard(final.summary, "summary");
  sanitized.remediation.text = guard(final.remediation.text, "remediation");
  sanitized.next_safe_steps = final.next_safe_steps.map((s, i) => guard(s, `step${i}`));
  return { ok: fatal.length === 0, fatal, redactions, sanitized, support };
}

function evidenceTime(raw: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/.exec(raw);
  if (!m) return NaN;
  const [year, month, day, hour, minute, second] = m.slice(1).map(Number);
  const days = [31, year! % 4 === 0 && (year! % 100 !== 0 || year! % 400 === 0) ? 29 : 28,31,30,31,30,31,31,30,31,30,31];
  if (month! < 1 || month! > 12 || day! < 1 || day! > days[month! - 1]! || hour! > 23 || minute! > 59 || second! > 59) return NaN;
  return Date.parse(raw);
}
