import { createHash } from "node:crypto";
import { parseWav, assembleWavParts } from "./wav";
import { callSignal, classifyHttpStatus, SpeechProviderError, toSpeechError, type CallControl, type FetchLike } from "./types";

/**
 * Sarvam Bulbul text-to-speech adapter. Contract source: docs.sarvam.ai/api-reference/text-to-speech/convert
 * (POST /text-to-speech, header `api-subscription-key`, JSON body, response `{ request_id, audios: [base64 WAV] }`).
 *
 * STATUS: CONTRACT_TESTED against recorded response shapes only. No live call has been made from this repository.
 * The endpoint is pinned (no override): an operator cannot point the key at another host.
 */
export const SARVAM_TTS_URL = "https://api.sarvam.ai/text-to-speech";
export const SARVAM_TTS_MODELS = ["bulbul:v2", "bulbul:v3", "bulbul:v4-flash"] as const;
export type SarvamTtsModel = (typeof SARVAM_TTS_MODELS)[number];
export const SARVAM_TTS_LANGUAGES = ["bn-IN", "en-IN", "gu-IN", "hi-IN", "kn-IN", "ml-IN", "mr-IN", "od-IN", "pa-IN", "ta-IN", "te-IN"] as const;
export type SarvamLanguage = (typeof SARVAM_TTS_LANGUAGES)[number];

const TEXT_LIMIT: Record<SarvamTtsModel, number> = { "bulbul:v2": 1500, "bulbul:v3": 2500, "bulbul:v4-flash": 2500 };
const PACE_RANGE: Record<SarvamTtsModel, [number, number]> = { "bulbul:v2": [0.3, 3], "bulbul:v3": [0.5, 2], "bulbul:v4-flash": [0.5, 2] };
const SAMPLE_RATES = new Set([8000, 16000, 22050, 24000]);
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_RESPONSE_BASE64 = 40 * 1024 * 1024;

export type SarvamTtsRequest = {
  text: string;
  model?: SarvamTtsModel;
  languageCode?: SarvamLanguage;
  /** Lowercase speaker id valid for the chosen model (provider rejects mismatches). Omit for the model default. */
  speaker?: string;
  pace?: number;
  sampleRate?: 8000 | 16000 | 22050 | 24000;
};

export type SarvamTtsResult = {
  wav: Buffer;
  durationMs: number;
  sha256: string;
  model: SarvamTtsModel;
  languageCode: SarvamLanguage;
  characters: number;
  chunkCount: number;
  providerRequestIds: string[];
};

export type SarvamTtsDeps = {
  fetch?: FetchLike;
  /** Defaults to CREATOR_TTS_SARVAM_API_KEY — a dedicated key, never the chat/LLM credential. */
  apiKey?: string;
  timeoutMs?: number;
};

/** Split at sentence ends, then whitespace, then (last resort) grapheme boundaries so no chunk exceeds `limit`. */
export function chunkSpeechText(text: string, limit: number): string[] {
  const clean = text.normalize("NFC").replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const sentences = clean.match(/[^.!?।…]+[.!?।…]*\s*/gu) ?? [clean];
  const pieces: string[] = [];
  for (const sentence of sentences) {
    let rest = sentence.trim();
    while (rest.length > limit) {
      let cut = rest.lastIndexOf(" ", limit);
      if (cut <= 0) {
        const graphemes = [...new Intl.Segmenter("ta", { granularity: "grapheme" }).segment(rest.slice(0, limit))].map(part => part.segment);
        cut = graphemes.slice(0, -1).join("").length || limit;
      }
      pieces.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) pieces.push(rest);
  }
  const chunks: string[] = [];
  for (const piece of pieces) {
    const last = chunks[chunks.length - 1];
    if (last !== undefined && last.length + 1 + piece.length <= limit) chunks[chunks.length - 1] = `${last} ${piece}`;
    else chunks.push(piece);
  }
  return chunks;
}

export function buildSarvamTtsPayload(request: SarvamTtsRequest, text: string) {
  const model = request.model ?? "bulbul:v3";
  if (!SARVAM_TTS_MODELS.includes(model)) throw new SpeechProviderError("SPEECH_MODEL_UNSUPPORTED", "INVALID_REQUEST", false);
  const languageCode = request.languageCode ?? "ta-IN";
  if (!SARVAM_TTS_LANGUAGES.includes(languageCode)) throw new SpeechProviderError("SPEECH_LANGUAGE_UNSUPPORTED", "INVALID_REQUEST", false);
  if (!text.trim() || text.length > TEXT_LIMIT[model]) throw new SpeechProviderError("SPEECH_TEXT_INVALID", "INVALID_REQUEST", false);
  const body: Record<string, unknown> = { text, language_code: languageCode, model, output_audio_codec: "wav", speech_sample_rate: request.sampleRate ?? 24000 };
  if (!SAMPLE_RATES.has(body.speech_sample_rate as number)) throw new SpeechProviderError("SPEECH_SAMPLE_RATE_INVALID", "INVALID_REQUEST", false);
  if (request.speaker !== undefined) {
    if (!/^[a-z0-9_]{2,64}$/.test(request.speaker)) throw new SpeechProviderError("SPEECH_SPEAKER_INVALID", "INVALID_REQUEST", false);
    body.speaker = request.speaker;
  }
  if (request.pace !== undefined) {
    const [min, max] = PACE_RANGE[model];
    if (!Number.isFinite(request.pace) || request.pace < min || request.pace > max) throw new SpeechProviderError("SPEECH_PACE_INVALID", "INVALID_REQUEST", false);
    body.pace = request.pace;
  }
  return { model, languageCode, body };
}

async function readProviderError(response: Response): Promise<never> {
  const { failureClass, retryable } = classifyHttpStatus(response.status);
  // The body is deliberately not surfaced: it can echo request text or account details.
  await response.arrayBuffer().catch(() => undefined);
  throw new SpeechProviderError(`SPEECH_PROVIDER_HTTP_${response.status}`, failureClass, retryable, response.status);
}

export async function synthesizeSarvamSpeech(request: SarvamTtsRequest, control: CallControl = {}, deps: SarvamTtsDeps = {}): Promise<SarvamTtsResult> {
  const apiKey = (deps.apiKey ?? process.env.CREATOR_TTS_SARVAM_API_KEY ?? "").trim();
  if (!apiKey) throw new SpeechProviderError("SPEECH_PROVIDER_NOT_CONFIGURED", "AUTH", false);
  const doFetch = deps.fetch ?? fetch;
  const model = request.model ?? "bulbul:v3";
  if (!SARVAM_TTS_MODELS.includes(model)) throw new SpeechProviderError("SPEECH_MODEL_UNSUPPORTED", "INVALID_REQUEST", false);
  const chunks = chunkSpeechText(request.text, TEXT_LIMIT[model]);
  if (!chunks.length) throw new SpeechProviderError("SPEECH_TEXT_INVALID", "INVALID_REQUEST", false);

  // Validate every chunk before the first billable call so a bad request never causes partial spend.
  const prepared = chunks.map(chunk => buildSarvamTtsPayload(request, chunk));
  const wavs: Array<{ id: string; wav: Buffer }> = [];
  const requestIds: string[] = [];

  for (let index = 0; index < prepared.length; index += 1) {
    if (control.signal?.aborted) throw new SpeechProviderError("SPEECH_CANCELLED", "CANCELLED", false);
    control.onProgress?.({ stage: "synthesize", completed: index, total: prepared.length });
    try {
      const response = await doFetch(SARVAM_TTS_URL, {
        method: "POST",
        headers: { "api-subscription-key": apiKey, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(prepared[index].body),
        redirect: "error",
        signal: callSignal(control.signal, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
      if (!response.ok) await readProviderError(response);
      const payload = (await response.json()) as { request_id?: string | null; audios?: unknown };
      const audio = Array.isArray(payload.audios) ? payload.audios[0] : undefined;
      if (typeof audio !== "string" || !audio || audio.length > MAX_RESPONSE_BASE64) throw new SpeechProviderError("SPEECH_PROVIDER_EMPTY_AUDIO", "ARTIFACT", true);
      const wav = Buffer.from(audio, "base64");
      try {
        parseWav(wav); // fail on a non-WAV or truncated payload before it is ever persisted
      } catch (wavError) {
        throw new SpeechProviderError((wavError as Error).message || "SPEECH_WAV_INVALID", "ARTIFACT", true);
      }
      wavs.push({ id: String(index), wav });
      if (payload.request_id) requestIds.push(String(payload.request_id));
    } catch (error) {
      throw toSpeechError(error, control);
    }
  }
  control.onProgress?.({ stage: "synthesize", completed: prepared.length, total: prepared.length, percent: 100 });

  let assembled: { wav: Buffer; durationMs: number };
  try {
    assembled = wavs.length === 1 ? { wav: wavs[0].wav, durationMs: parseWav(wavs[0].wav).durationMs } : assembleWavParts(wavs, 0);
  } catch (assembleError) {
    throw new SpeechProviderError((assembleError as Error).message || "SPEECH_WAV_INVALID", "ARTIFACT", true);
  }
  return {
    wav: assembled.wav,
    durationMs: assembled.durationMs,
    sha256: createHash("sha256").update(assembled.wav).digest("hex"),
    model: prepared[0].model,
    languageCode: prepared[0].languageCode,
    characters: chunks.reduce((sum, chunk) => sum + chunk.length, 0),
    chunkCount: chunks.length,
    providerRequestIds: requestIds,
  };
}
