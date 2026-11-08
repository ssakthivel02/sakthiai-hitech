import type { RenderCaptionCue } from "../renderPlan";

/**
 * Tamil caption builder for approved lyric/narration lines. Pure; no model, no transcription.
 *
 * The Tamil text is NEVER generated or "corrected" here: it is the human-approved source, normalised only for Unicode
 * form and whitespace. Cues are always returned UNLOCKED — locking is the human Tamil review gate, and the renderer
 * (serializeSrt) refuses unlocked cues.
 */
export type ApprovedCaptionLine = {
  lineId: string;
  startMs: number;
  endMs: number;
  textTa: string;
  /** Optional forced-alignment per whitespace token (from real audio analysis). Absent = proportional timing. */
  wordTimings?: ReadonlyArray<{ startMs: number; endMs: number }>;
};

export type CaptionIssue = { code: string; lineId?: string; detail?: string };

export type BuiltCaptions = {
  cues: Array<RenderCaptionCue & { lineId: string }>;
  timing: "AUDIO_ALIGNED" | "PROPORTIONAL_UNVERIFIED";
  humanReviewRequired: true;
  issues: CaptionIssue[];
};

const graphemes = new Intl.Segmenter("ta", { granularity: "grapheme" });
export const graphemeCount = (text: string) => [...graphemes.segment(text)].length;

/** NFC + whitespace only. ZWJ/ZWNJ are kept (they control Tamil ligatures); BOM, ZWSP and soft hyphen are removed. */
export function normalizeTamilText(text: string): string {
  return text
    .normalize("NFC")
    .replace(/[﻿​­]/g, "")
    .replace(/[  -   　]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const ALLOWED = /^[஀-௿ -~‐-‧‌‍]+$/u;

function pack(tokens: readonly string[], maxGraphemes: number): number[][] {
  const groups: number[][] = [];
  let current: number[] = [];
  let size = 0;
  tokens.forEach((token, index) => {
    const length = graphemeCount(token);
    if (current.length && size + 1 + length > maxGraphemes) { groups.push(current); current = []; size = 0; }
    current.push(index);
    size += (current.length > 1 ? 1 : 0) + length;
  });
  if (current.length) groups.push(current);
  return groups;
}

export type CaptionOptions = { maxGraphemesPerCue?: number; minCueMs?: number };

export function buildCaptionCues(lines: readonly ApprovedCaptionLine[], audioDurationMs: number, options: CaptionOptions = {}): BuiltCaptions {
  const maxGraphemes = options.maxGraphemesPerCue ?? 40;
  const minCueMs = options.minCueMs ?? 700;
  if (!Number.isInteger(audioDurationMs) || audioDurationMs <= 0) throw new Error("CAPTION_AUDIO_DURATION_INVALID");
  const cues: BuiltCaptions["cues"] = [];
  const issues: CaptionIssue[] = [];
  let aligned = true;
  let previousEnd = 0;

  for (const line of lines) {
    if (!Number.isInteger(line.startMs) || !Number.isInteger(line.endMs) || line.endMs <= line.startMs) throw new Error(`CAPTION_LINE_RANGE_INVALID:${line.lineId}`);
    if (line.startMs < previousEnd) throw new Error(`CAPTION_LINE_OVERLAP:${line.lineId}`);
    if (line.endMs > audioDurationMs) throw new Error(`CAPTION_LINE_OUTSIDE_AUDIO:${line.lineId}`);
    previousEnd = line.endMs;
    const text = normalizeTamilText(line.textTa);
    if (!text) throw new Error(`CAPTION_LINE_TEXT_REQUIRED:${line.lineId}`);
    if (!ALLOWED.test(text)) issues.push({ code: "CAPTION_UNEXPECTED_CHARACTERS", lineId: line.lineId, detail: [...text].filter(ch => !ALLOWED.test(ch)).slice(0, 5).join("") });
    const language = /[஀-௿]/u.test(text) ? "ta" : "en";
    const tokens = text.split(" ");
    const span = line.endMs - line.startMs;
    const lineCues: Array<{ startMs: number; endMs: number; text: string }> = [];

    if (line.wordTimings) {
      if (line.wordTimings.length !== tokens.length) throw new Error(`CAPTION_WORD_TIMINGS_MISMATCH:${line.lineId}`);
      let cursor = line.startMs;
      for (const group of pack(tokens, maxGraphemes)) {
        const first = line.wordTimings[group[0]];
        const last = line.wordTimings[group[group.length - 1]];
        const start = Math.max(cursor, first.startMs, line.startMs);
        const end = Math.min(line.endMs, last.endMs);
        if (end <= start) throw new Error(`CAPTION_WORD_TIMINGS_INVALID:${line.lineId}`);
        lineCues.push({ startMs: start, endMs: end, text: group.map(i => tokens[i]).join(" ") });
        cursor = end;
      }
    } else {
      aligned = false;
      const needed = pack(tokens, maxGraphemes).length;
      const allowed = Math.max(1, Math.floor(span / minCueMs));
      const targetGroups = Math.min(needed, allowed);
      if (targetGroups < needed) issues.push({ code: "CAPTION_CUE_DENSE", lineId: line.lineId, detail: `${needed} cues need ${needed * minCueMs}ms; line has ${span}ms` });
      let limit = maxGraphemes;
      let groups = pack(tokens, limit);
      while (groups.length > targetGroups && limit < text.length + 1) { limit += 2; groups = pack(tokens, limit); }
      const sizes = groups.map(group => graphemeCount(group.map(i => tokens[i]).join(" ")));
      const total = sizes.reduce((a, b) => a + b, 0);
      let consumed = 0;
      let start = line.startMs;
      groups.forEach((group, index) => {
        consumed += sizes[index];
        const end = index === groups.length - 1 ? line.endMs : line.startMs + Math.round((span * consumed) / total);
        lineCues.push({ startMs: start, endMs: end, text: group.map(i => tokens[i]).join(" ") });
        start = end;
      });
    }
    for (const cue of lineCues) cues.push({ ...cue, language, locked: false, lineId: line.lineId });
  }

  return { cues, timing: aligned && lines.length > 0 ? "AUDIO_ALIGNED" : "PROPORTIONAL_UNVERIFIED", humanReviewRequired: true, issues };
}

/**
 * Compare the cues against the approved source token by token. Catches dropped, duplicated and substituted Tamil words
 * (runbook §6). Equality is on NFC-normalised text, so a visually identical but differently encoded word still matches.
 */
export function verifyCaptionsMatchSource(cues: ReadonlyArray<{ text: string; lineId?: string }>, lines: readonly ApprovedCaptionLine[]): CaptionIssue[] {
  const issues: CaptionIssue[] = [];
  for (const line of lines) {
    const expected = normalizeTamilText(line.textTa).split(" ");
    const actual = cues.filter(cue => cue.lineId === line.lineId).flatMap(cue => normalizeTamilText(cue.text).split(" "));
    if (expected.length === actual.length && expected.every((token, i) => token === actual[i])) continue;
    const at = expected.findIndex((token, i) => token !== actual[i]);
    const index = at === -1 ? Math.min(expected.length, actual.length) : at;
    const kind = actual.length < expected.length ? "DROPPED" : actual.length > expected.length ? "DUPLICATED_OR_ADDED" : "SUBSTITUTED";
    issues.push({ code: `CAPTION_TEXT_${kind}`, lineId: line.lineId, detail: `token ${index}: expected "${expected[index] ?? ""}" got "${actual[index] ?? ""}"` });
  }
  const known = new Set(lines.map(line => line.lineId));
  for (const cue of cues) if (cue.lineId && !known.has(cue.lineId)) issues.push({ code: "CAPTION_UNKNOWN_LINE", lineId: cue.lineId });
  return issues;
}
