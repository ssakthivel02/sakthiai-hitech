/**
 * Truthful grounding state for the chat path.
 *
 * GROUNDED_EVIDENCE    evidence existed AND the model produced an answer from it.
 * INSUFFICIENT_EVIDENCE no evidence was retrieved, or the model itself declared the
 *                       evidence insufficient (exact sentinel).
 * MODEL_UNAVAILABLE    evidence exists but answer generation failed or returned nothing.
 *                       No answer text is fabricated; retrieved evidence is still surfaced.
 */
export const INSUFFICIENT_EVIDENCE_SENTINEL = "INSUFFICIENT_EVIDENCE";

export type GroundingState = "GROUNDED_EVIDENCE" | "INSUFFICIENT_EVIDENCE" | "MODEL_UNAVAILABLE";

export type ChatLanguage = "en" | "ta";

export type ModelResult =
  | { status: "failed" }
  | { status: "returned"; content: unknown };

export type GroundedOutcome = {
  answer: string;
  grounding: GroundingState;
  /** Whether the retrieved evidence citations accompany this outcome. */
  includeCitations: boolean;
};

export function modelUnavailableMessage(language: ChatLanguage, evidenceCount: number): string {
  return language === "ta"
    ? `பதிலை உருவாக்க இப்போது இயலவில்லை. தொடர்புடைய ${evidenceCount} ஆதாரப் பகுதி(கள்) கீழே உள்ளன.`
    : `The answer could not be generated right now. ${evidenceCount} relevant source excerpt(s) are listed below.`;
}

const MODEL_DECLARED_INSUFFICIENT = /^INSUFFICIENT_EVIDENCE[\s.!]*$/;

/** Decides the response state AFTER evidence was retrieved (evidenceCount > 0). */
export function resolveGroundedOutcome(input: {
  language: ChatLanguage;
  evidenceCount: number;
  model: ModelResult;
}): GroundedOutcome {
  if (input.model.status === "returned") {
    const content = input.model.content;
    if (typeof content === "string" && content.trim()) {
      if (MODEL_DECLARED_INSUFFICIENT.test(content.trim())) {
        return { answer: INSUFFICIENT_EVIDENCE_SENTINEL, grounding: "INSUFFICIENT_EVIDENCE", includeCitations: false };
      }
      return { answer: content, grounding: "GROUNDED_EVIDENCE", includeCitations: true };
    }
  }
  return {
    answer: modelUnavailableMessage(input.language, input.evidenceCount),
    grounding: "MODEL_UNAVAILABLE",
    includeCitations: true,
  };
}
