/**
 * Turns API failures into short, accessible, secret-free messages (English / Tamil). Pure: shared by the client and tests.
 * Raw server text is NEVER shown for an unrecognised error (it could carry internals); only a fixed generic message is.
 */
export type UiLanguage = "en" | "ta";
export type UiErrorKind = "rate_limit" | "limits_unavailable" | "unavailable" | "model_unavailable" | "budget" | "denied" | "session" | "uploads_off" | "invalid" | "offline" | "unknown";
export type UiError = { kind: UiErrorKind; message: string; retryable: boolean; retryAfterSeconds?: number };
export type ApiErrorLike = { message?: unknown; data?: { code?: unknown; httpStatus?: unknown } | null; name?: unknown };

const TEXT: Record<UiErrorKind, { en: (s?: number) => string; ta: (s?: number) => string }> = {
  rate_limit: {
    en: s => `You are sending requests too quickly. Please wait${s ? ` ${s} seconds` : " a moment"} and try again.`,
    ta: s => `நீங்கள் மிக வேகமாக கோரிக்கைகளை அனுப்புகிறீர்கள். ${s ? `${s} விநாடிகள்` : "சிறிது நேரம்"} காத்திருந்து மீண்டும் முயலவும்.`,
  },
  limits_unavailable: {
    en: s => `Request limits are temporarily unavailable, so this action was not run. Please try again${s ? ` in ${s} seconds` : " shortly"}.`,
    ta: s => `கோரிக்கை வரம்புகளைச் சரிபார்க்க இப்போது இயலவில்லை, எனவே இந்தச் செயல் நடைபெறவில்லை. ${s ? `${s} விநாடிகளுக்குப் பிறகு` : "சிறிது நேரத்தில்"} மீண்டும் முயலவும்.`,
  },
  unavailable: {
    en: () => "The service is having trouble right now and your request was not completed. Please try again in a minute.",
    ta: () => "சேவையில் இப்போது சிக்கல் உள்ளது; உங்கள் கோரிக்கை முடிக்கப்படவில்லை. ஒரு நிமிடம் கழித்து மீண்டும் முயலவும்.",
  },
  model_unavailable: {
    en: () => "The answer service could not respond right now. Matching source excerpts are shown below. Please try again shortly.",
    ta: () => "பதில் சேவையால் இப்போது பதிலளிக்க இயலவில்லை. பொருந்தும் ஆதாரப் பகுதிகள் கீழே உள்ளன. சிறிது நேரத்தில் மீண்டும் முயலவும்.",
  },
  budget: {
    en: () => "The answer service has reached its usage limit for now. Please try again later.",
    ta: () => "பதில் சேவை தற்போதைய பயன்பாட்டு வரம்பை எட்டியுள்ளது. பின்னர் மீண்டும் முயலவும்.",
  },
  denied: {
    en: () => "You do not have access to this item. If you think this is a mistake, report it with the time it happened.",
    ta: () => "இந்த உருப்படிக்கு உங்களுக்கு அணுகல் இல்லை. இது பிழை என்று நினைத்தால், நிகழ்ந்த நேரத்துடன் தெரிவிக்கவும்.",
  },
  session: {
    en: () => "Your session has ended. Please sign in again.",
    ta: () => "உங்கள் அமர்வு முடிந்துவிட்டது. மீண்டும் உள்நுழையவும்.",
  },
  uploads_off: {
    en: () => "File uploads are not enabled in this beta.",
    ta: () => "இந்த பீட்டாவில் கோப்புப் பதிவேற்றம் இயக்கப்படவில்லை.",
  },
  invalid: {
    en: () => "That input was not accepted. Please check it and try again.",
    ta: () => "அந்த உள்ளீடு ஏற்கப்படவில்லை. சரிபார்த்து மீண்டும் முயலவும்.",
  },
  offline: {
    en: () => "The connection to the service was lost. Check your internet connection and try again.",
    ta: () => "சேவையுடனான இணைப்பு துண்டிக்கப்பட்டது. இணைய இணைப்பைச் சரிபார்த்து மீண்டும் முயலவும்.",
  },
  unknown: {
    en: () => "Something went wrong and your request was not completed. Please try again. If it keeps happening, report it with the time it happened.",
    ta: () => "ஏதோ தவறு நேர்ந்தது; உங்கள் கோரிக்கை முடிக்கப்படவில்லை. மீண்டும் முயலவும். தொடர்ந்தால், நிகழ்ந்த நேரத்துடன் தெரிவிக்கவும்.",
  },
};

const RETRYABLE: Record<UiErrorKind, boolean> = { rate_limit: true, limits_unavailable: true, unavailable: true, model_unavailable: true, budget: false, denied: false, session: false, uploads_off: false, invalid: false, offline: true, unknown: true };
const retryAfter = (message: string): number | undefined => {
  const match = /Retry in (\d{1,5}) seconds?/i.exec(message);
  return match ? Math.min(Number(match[1]), 3600) : undefined;
};
const build = (kind: UiErrorKind, language: UiLanguage, seconds?: number): UiError => ({ kind, message: TEXT[kind][language](seconds), retryable: RETRYABLE[kind], ...(seconds ? { retryAfterSeconds: seconds } : {}) });

/** Classify a thrown API/network error. `language` selects the user-facing text only. */
export function describeApiError(error: unknown, language: UiLanguage = "en"): UiError {
  const e = (error && typeof error === "object" ? error : {}) as ApiErrorLike;
  const message = typeof e.message === "string" ? e.message : "";
  const code = typeof e.data?.code === "string" ? e.data.code : "";
  const status = typeof e.data?.httpStatus === "number" ? e.data.httpStatus : undefined;
  const seconds = retryAfter(message);

  if (/^Request limits are temporarily unavailable/i.test(message)) return build("limits_unavailable", language, seconds);
  if (/^Rate limit exceeded/i.test(message) || code === "TOO_MANY_REQUESTS" || status === 429) return build("rate_limit", language, seconds);
  if (message === "Please login (10001)" || code === "UNAUTHORIZED" || status === 401) return build("session", language);
  if (/File uploads are not enabled/i.test(message)) return build("uploads_off", language);
  if (code === "FORBIDDEN" || status === 403 || /access denied|required permission/i.test(message)) return build("denied", language);
  if (code === "BAD_REQUEST" || code === "PAYLOAD_TOO_LARGE" || status === 400 || status === 413) return build("invalid", language);
  if (code === "CONFLICT" || code === "NOT_FOUND" || status === 404 || status === 409) return build("invalid", language);
  if (/failed to fetch|networkerror|network request failed|load failed|fetch failed/i.test(message) || (!code && e.name === "TypeError")) return build("offline", language);
  if (code === "INTERNAL_SERVER_ERROR" || code === "SERVICE_UNAVAILABLE" || code === "TIMEOUT" || code === "BAD_GATEWAY" || (status !== undefined && status >= 500)) return build("unavailable", language);
  return build("unknown", language);
}

/** `chat.send` returns HTTP 200 even when no model answered; its gateway failure reason decides the notice. */
export function describeModelFailure(failureReason: string | undefined, language: UiLanguage = "en"): UiError {
  if (failureReason === "budget_denied" || failureReason === "policy_denied") return build("budget", language);
  return build("model_unavailable", language);
}

/** Explains the literal INSUFFICIENT_EVIDENCE answer. `modelUsed` is false when retrieval found nothing and no model was called. */
export function describeNoEvidence(modelUsed: boolean, language: UiLanguage = "en"): string {
  if (!modelUsed) {
    return language === "ta"
      ? "உங்கள் கேள்விக்குப் பொருந்தும் அங்கீகரிக்கப்பட்ட ஆதாரம் இந்தப் பணியிடத்தில் இல்லை; எனவே பதில் உருவாக்கப்படவில்லை, மாடல் பயன்படுத்தப்படவில்லை."
      : "No approved source in this workspace matches your question, so no answer was generated and no model was used.";
  }
  return language === "ta"
    ? "கண்டறியப்பட்ட அங்கீகரிக்கப்பட்ட ஆதாரங்களில் இந்தக் கேள்விக்குப் பதிலளிக்கப் போதிய தகவல் இல்லை."
    : "The approved sources found do not contain enough information to answer this question.";
}

export const ERROR_UI_TEXT = {
  en: { title: "That did not work", retry: "Try again", dismiss: "Dismiss", projectAdded: "Project added." },
  ta: { title: "இது நிறைவேறவில்லை", retry: "மீண்டும் முயல்க", dismiss: "மூடு", projectAdded: "திட்டம் சேர்க்கப்பட்டது." },
} as const;
