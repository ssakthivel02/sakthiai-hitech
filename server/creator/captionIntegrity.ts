/**
 * Validate human-approved lyric/caption text without rewriting Tamil graphemes.
 * SRT and libass interpret embedded timing delimiters and styling markup;
 * reject those at both cue-ingest and render time so previously persisted cues
 * cannot silently change timing, position, font or meaning during export.
 */
export function validateCreatorCaptionText(raw: string): string {
  if (typeof raw !== "string") throw new Error("CREATOR_CAPTION_TEXT_REQUIRED");
  const text = raw.trim();
  if (!text) throw new Error("CREATOR_CAPTION_TEXT_REQUIRED");
  if (text.length > 600) throw new Error("CREATOR_CAPTION_TEXT_TOO_LONG");

  // CR/Unicode separators/control characters can create ambiguous SRT records.
  // Bidi overrides can visually spoof reviewed lyrics. Tamil vowel signs,
  // combining marks, and ZWJ/ZWNJ remain untouched.
  if (/[\r\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069]/u.test(text)) {
    throw new Error("CREATOR_CAPTION_CONTROL_CHARACTER_FORBIDDEN");
  }
  const lines = text.split("\n");
  if (lines.length > 2 || lines.some(line => !line || line.trim() !== line)) {
    throw new Error("CREATOR_CAPTION_LINE_LAYOUT_INVALID");
  }
  if (text.includes("-->")) throw new Error("CREATOR_CAPTION_SRT_TIMING_MARKUP_FORBIDDEN");
  if (/<[^>]*>/u.test(text) || /\{\\[^}]*\}/u.test(text)) {
    throw new Error("CREATOR_CAPTION_STYLE_MARKUP_FORBIDDEN");
  }
  return text;
}
