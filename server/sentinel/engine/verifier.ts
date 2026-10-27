import type { CaseDoc, FinalAnswer } from "./types";
import { READ_TOOLS, WRITE_TOOLS } from "./types";
import type { EvidenceItem } from "./broker";
import { INJECTION_PATTERNS } from "./broker";
import { KB_BY_LABEL, matchedSigs, toolsOf } from "./kb";

export interface VerifyOptions {
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

export function verifyFinal(final: FinalAnswer, c: CaseDoc, evidence: Map<string, EvidenceItem>, taxonomy: Record<string, string>, opts: VerifyOptions): VerifyResult {
  const fatal: string[] = [], redactions: string[] = [];
  const sanitized: FinalAnswer = JSON.parse(JSON.stringify(final));
  // --- schema
  const str = (x: unknown, max: number) => typeof x === "string" && x.length <= max;
  if (final.outcome !== "DIAGNOSIS" && final.outcome !== "ABSTAIN") fatal.push("SCHEMA:outcome");
  if (!str(final.label, 60) || !(final.label in taxonomy)) fatal.push("SCHEMA:label-not-in-taxonomy");
  if (final.outcome === "DIAGNOSIS" && final.label === "INCONCLUSIVE") fatal.push("SCHEMA:diagnosis-with-inconclusive-label");
  if (final.outcome === "ABSTAIN" && final.label !== "INCONCLUSIVE") fatal.push("SCHEMA:abstain-with-specific-label");
  if (!str(final.summary, 1500)) fatal.push("SCHEMA:summary");
  if (typeof final.confidence !== "number" || final.confidence < 0 || final.confidence > 1) fatal.push("SCHEMA:confidence");
  if (!Array.isArray(final.cited) || final.cited.some((x) => typeof x !== "string")) fatal.push("SCHEMA:cited");
  if (!Array.isArray(final.contradictions) || final.contradictions.some((p) => !Array.isArray(p) || p.length !== 2)) fatal.push("SCHEMA:contradictions");
  if (!final.remediation || typeof final.remediation.text !== "string") fatal.push("SCHEMA:remediation");
  else if (final.remediation.executed !== false || final.remediation.requires_approval !== true) fatal.push("APPROVAL:remediation-must-be-unexecuted-and-require-approval");
  if (!Array.isArray(final.next_safe_steps)) fatal.push("SCHEMA:next_safe_steps");
  if (fatal.some((f) => f.startsWith("SCHEMA"))) return { ok: false, fatal, redactions, sanitized, support: null };
  // --- citations
  const cited = final.cited;
  for (const rid of cited) {
    const ev = evidence.get(rid);
    if (!ev) fatal.push(`CITATION:unknown-evidence:${rid}`);
    else if (ev.quarantined) fatal.push(`CITATION:quarantined-evidence:${rid}`);
  }
  for (const [a, b] of final.contradictions) for (const rid of [a, b]) if (!evidence.has(rid)) fatal.push(`CONTRADICTION:unknown-evidence:${rid}`);
  // --- independence + support for a diagnosis
  let support: VerifyResult["support"] = null;
  if (final.outcome === "DIAGNOSIS") {
    const items = cited.map((r) => evidence.get(r)).filter((x): x is EvidenceItem => !!x && !x.quarantined);
    const tools = new Set(items.map((i) => i.tool));
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
  const texts: Array<[string, string]> = [["summary", final.summary], ["remediation", final.remediation.text], ...final.next_safe_steps.map((s, i) => [`step${i}`, s] as [string, string])];
  for (const [where, t] of texts) for (const p of FALSE_CLAIM_PATTERNS) if (p.test(t)) { fatal.push(`CLAIM:false-remediation-claim in ${where}`); break; }
  // --- echo guard (non-fatal, redacts): hostnames/URLs not present in the case, injection-like phrases
  const caseText = JSON.stringify(c).toLowerCase();
  const known = new Set<string>([...READ_TOOLS, ...WRITE_TOOLS].map((s) => s.toLowerCase()));
  const guard = (s: string, where: string): string => {
    let out = s.replace(/https?:\/\/\S+/gi, () => { redactions.push(`${where}:url`); return "[REDACTED-URL]"; });
    out = out.replace(FQDN, (m) => { const l = m.toLowerCase(); if (known.has(l) || caseText.includes(l)) return m; redactions.push(`${where}:entity`); return "[REDACTED-ENTITY]"; });
    for (const p of INJECTION_PATTERNS) if (p.re.test(out)) { redactions.push(`${where}:injection-phrase:${p.id}`); out = "[REDACTED-INSTRUCTION-LIKE-TEXT]"; break; }
    return out;
  };
  sanitized.summary = guard(final.summary, "summary");
  sanitized.remediation.text = guard(final.remediation.text, "remediation");
  sanitized.next_safe_steps = final.next_safe_steps.map((s, i) => guard(s, `step${i}`));
  return { ok: fatal.length === 0, fatal, redactions, sanitized, support };
}
