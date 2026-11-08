import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Deterministic part of the offline Tamil evaluation. It contains NO model calls, NO network access and NO scores.
 * Hard checks are mechanical (script integrity, citation ids, canary leakage, verbatim strings). Language quality, correctness and
 * faithfulness are judged by blind human review (see RUBRIC.md) and are never inferred here.
 */
export type TamilCheck = { tamilScript?: boolean; minTamilRatio?: number; mustCite?: string[]; mustNotCite?: string[]; mustContainAny?: string[]; mustNotContain?: string[]; mustAbstain?: boolean };
export type TamilItem = { id: string; category: string; prompt: string; system?: string; context?: Array<{ id: string; text: string }>; checks: TamilCheck; reference: string };
export type TamilEvalSet = { schema: string; status: string; note: string; canary: string; categories: string[]; items: TamilItem[] };

const here = path.dirname(fileURLToPath(import.meta.url));
export const loadTamilEvalSet = (file = path.join(here, "tamil-eval-set.json")): TamilEvalSet => JSON.parse(fs.readFileSync(file, "utf8"));

const isTamil = (cp: number) => cp >= 0x0b80 && cp <= 0x0bff;
/** Tamil dependent signs that cannot start a word: vowel signs, virama, au length mark. */
const isDependentSign = (cp: number) => (cp >= 0x0bbe && cp <= 0x0bcd) || cp === 0x0bd7;

export function tamilStats(text: string) {
  let tamil = 0, letters = 0, replacement = 0, orphanSigns = 0, prevTamil = false;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0xfffd) replacement++;
    if (isTamil(cp)) { tamil++; letters++; if (isDependentSign(cp) && !prevTamil) orphanSigns++; prevTamil = true; continue; }
    prevTamil = false;
    if (/\p{L}/u.test(ch)) letters++;
  }
  return { tamilChars: tamil, letters, ratio: letters ? tamil / letters : 0, replacementChars: replacement, orphanSigns };
}

export const ABSTAIN_MARKERS = ["தகவல் இல்லை", "தகவல் கிடைக்கவில்லை", "தெரியவில்லை", "கொடுக்க இயலாது", "முடியாது", "இயலாது", "உறுதிப்படுத்த", "not enough", "does not contain", "do not have", "don't have", "cannot", "can't", "unable", "not sure"];

const citedIds = (text: string) => [...text.matchAll(/\[(D\d+)\]/g)].map((m) => m[1]);

export type HardCheckResult = { id: string; passed: boolean; failures: string[]; abstentionHeuristic?: boolean };
/** Mechanical checks only. `mustAbstain` is a heuristic marker match: a human confirms every abstention verdict. */
export function runHardChecks(item: TamilItem, response: string): HardCheckResult {
  const c = item.checks, failures: string[] = [];
  const s = tamilStats(response);
  if (!response.trim()) failures.push("empty_response");
  if (s.replacementChars > 0) failures.push("replacement_character");
  if (s.orphanSigns > 0) failures.push("orphan_combining_sign");
  if (c.tamilScript && s.tamilChars === 0) failures.push("no_tamil_script");
  if (c.minTamilRatio !== undefined && s.ratio < c.minTamilRatio) failures.push("tamil_ratio_below_minimum");
  const cited = new Set(citedIds(response));
  const known = new Set((item.context ?? []).map((p) => p.id));
  for (const id of cited) if (!known.has(id)) failures.push(`hallucinated_citation:${id}`);
  for (const id of c.mustCite ?? []) if (!cited.has(id)) failures.push(`missing_citation:${id}`);
  for (const id of c.mustNotCite ?? []) if (cited.has(id)) failures.push(`forbidden_citation:${id}`);
  if (c.mustContainAny && !c.mustContainAny.some((x) => response.includes(x))) failures.push("missing_required_content");
  for (const x of c.mustNotContain ?? []) if (response.includes(x)) failures.push(`forbidden_content:${x === "CANARY-7QX" ? "canary" : "string"}`);
  let abstentionHeuristic: boolean | undefined;
  if (c.mustAbstain) { abstentionHeuristic = ABSTAIN_MARKERS.some((m) => response.toLowerCase().includes(m.toLowerCase())); if (!abstentionHeuristic) failures.push("no_abstention_marker"); }
  return { id: item.id, passed: failures.length === 0, failures, ...(abstentionHeuristic !== undefined ? { abstentionHeuristic } : {}) };
}

const ITEM_KEYS = ["id", "category", "prompt", "system", "context", "checks", "reference"];
/** Structural validation of the set itself (not of any model). Returns problems; empty means well-formed. */
export function validateEvalSet(set: TamilEvalSet): string[] {
  const errs: string[] = [];
  const ids = new Set<string>();
  for (const it of set.items) {
    if (ids.has(it.id)) errs.push(`duplicate id ${it.id}`); ids.add(it.id);
    if (!set.categories.includes(it.category)) errs.push(`${it.id}: unknown category`);
    if (!it.prompt.trim() || !it.reference.trim()) errs.push(`${it.id}: prompt and reference are required`);
    const known = new Set((it.context ?? []).map((p) => p.id));
    for (const id of [...(it.checks.mustCite ?? []), ...(it.checks.mustNotCite ?? [])]) if (!known.has(id)) errs.push(`${it.id}: check refers to unknown passage ${id}`);
    for (const x of it.checks.mustNotContain ?? []) if (x === set.canary && !(it.system ?? "").includes(set.canary)) errs.push(`${it.id}: canary check without canary in system prompt`);
    for (const key of Object.keys(it)) if (!ITEM_KEYS.includes(key)) errs.push(`${it.id}: unexpected field ${key} (the set must carry no scores or results)`);
  }
  for (const cat of set.categories) if (!set.items.some((i) => i.category === cat)) errs.push(`category ${cat} has no items`);
  return errs;
}

export type ResultRow = { id: string; response: string; latencyMs?: number; human?: { fluency: number; correctness: number; faithfulness: number } };
/** Proposed pass bars (from the Q8 package). They are PROPOSED: the owner must ratify them before the first paid run. */
export const PROPOSED_PASS_BARS = { scriptIntegrity: 1, humanMeanMin: 3.5, hallucinatedCitationRateMax: 0.1, p95LatencyMsMax: 20_000 } as const;

export type Verdict = "NOT_RUN" | "INCOMPLETE_HUMAN_REVIEW" | "FAIL" | "PASS_ON_THIS_SET";
export function summarise(set: TamilEvalSet, rows: ResultRow[]) {
  if (!rows.length) return { verdict: "NOT_RUN" as Verdict, reasons: ["no results supplied"] };
  const byId = new Map(set.items.map((i) => [i.id, i]));
  const reasons: string[] = [];
  const unknown = rows.filter((r) => !byId.has(r.id)); if (unknown.length) reasons.push(`unknown ids: ${unknown.map((u) => u.id).join(",")}`);
  const missing = set.items.filter((i) => !rows.some((r) => r.id === i.id)); if (missing.length) reasons.push(`items not run: ${missing.length}`);
  const checks = rows.filter((r) => byId.has(r.id)).map((r) => ({ r, hc: runHardChecks(byId.get(r.id)!, r.response) }));
  const integrityFail = checks.filter((x) => x.hc.failures.some((f) => f === "replacement_character" || f === "orphan_combining_sign" || f === "empty_response" || f === "no_tamil_script" || f === "tamil_ratio_below_minimum"));
  if (integrityFail.length) reasons.push(`script integrity failures: ${integrityFail.length}`);
  const grounded = checks.filter((x) => (byId.get(x.r.id)!.context ?? []).length > 0);
  const halluc = grounded.filter((x) => x.hc.failures.some((f) => f.startsWith("hallucinated_citation")));
  if (grounded.length && halluc.length / grounded.length > PROPOSED_PASS_BARS.hallucinatedCitationRateMax) reasons.push("hallucinated citation rate above bar");
  const otherHard = checks.filter((x) => !x.hc.passed && !integrityFail.includes(x));
  if (otherHard.length) reasons.push(`other hard-check failures: ${otherHard.length}`);
  const lat = rows.map((r) => r.latencyMs).filter((n): n is number => typeof n === "number").sort((a, b) => a - b);
  if (lat.length) { const p95 = lat[Math.min(lat.length - 1, Math.ceil(0.95 * lat.length) - 1)]; if (p95 > PROPOSED_PASS_BARS.p95LatencyMsMax) reasons.push(`p95 latency ${p95} ms above bar`); }
  const humans = rows.filter((r) => r.human);
  if (humans.length < rows.length) return { verdict: (reasons.length ? "FAIL" : "INCOMPLETE_HUMAN_REVIEW") as Verdict, reasons: [...reasons, `human review present for ${humans.length}/${rows.length} rows`] };
  for (const dim of ["fluency", "correctness", "faithfulness"] as const) {
    const mean = humans.reduce((n, r) => n + r.human![dim], 0) / humans.length;
    if (mean < PROPOSED_PASS_BARS.humanMeanMin) reasons.push(`${dim} mean ${mean.toFixed(2)} below ${PROPOSED_PASS_BARS.humanMeanMin}`);
  }
  return { verdict: (reasons.length ? "FAIL" : "PASS_ON_THIS_SET") as Verdict, reasons };
}
