import { describe, expect, it } from "vitest";
import { validateCreatorCaptionText } from "./captionIntegrity";

describe("Creator Tamil caption integrity", () => {
  it("preserves Tamil graphemes, punctuation and approved two-line lyrics", () => {
    expect(validateCreatorCaptionText("  வேல் முருகா!  ")).toBe("வேல் முருகா!");
    expect(validateCreatorCaptionText("முருகா\nஅருள் தருவாய்")).toBe("முருகா\nஅருள் தருவாய்");
    expect(validateCreatorCaptionText("க்\u200dஷ" )).toBe("க்\u200dஷ");
  });
  it("rejects forged SRT timestamps and libass/HTML formatting overrides", () => {
    expect(() => validateCreatorCaptionText("முருகா\n00:00:01,000 --> 00:00:09,000"))
      .toThrow("CREATOR_CAPTION_SRT_TIMING_MARKUP_FORBIDDEN");
    expect(() => validateCreatorCaptionText("<font color='red'>முருகா</font>"))
      .toThrow("CREATOR_CAPTION_STYLE_MARKUP_FORBIDDEN");
    expect(() => validateCreatorCaptionText("{\\an8}முருகா"))
      .toThrow("CREATOR_CAPTION_STYLE_MARKUP_FORBIDDEN");
  });
  it("rejects control characters, bidi spoofing and ambiguous line layouts", () => {
    for (const text of ["முரு\rகா", "முரு\u0000கா", "முரு\u202Eகா", "முரு\u2028கா"]) {
      expect(() => validateCreatorCaptionText(text)).toThrow("CREATOR_CAPTION_CONTROL_CHARACTER_FORBIDDEN");
    }
    for (const text of ["முருகா\nஅருள்\nவேல்", "முருகா\n\nவேல்", "முருகா\n வேல்"]) {
      expect(() => validateCreatorCaptionText(text)).toThrow("CREATOR_CAPTION_LINE_LAYOUT_INVALID");
    }
  });
  it("rejects empty or overlong captions", () => {
    expect(() => validateCreatorCaptionText("   ")).toThrow("CREATOR_CAPTION_TEXT_REQUIRED");
    expect(() => validateCreatorCaptionText("ம".repeat(601))).toThrow("CREATOR_CAPTION_TEXT_TOO_LONG");
  });
});
