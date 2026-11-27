import { describe, expect, it, vi } from "vitest";
import { buildSarvamTtsPayload, chunkSpeechText, SARVAM_TTS_URL, synthesizeSarvamSpeech } from "./sarvamTts";
import { makePcmWav, parseWav } from "./wav";
import { SpeechProviderError } from "./types";

const ok = (wav: Buffer, id = "req-1") => new Response(JSON.stringify({ request_id: id, audios: [wav.toString("base64")] }), { status: 200 });
const TAMIL = "முருகா வேல் வேல். கந்தன் கருணை புரிவான்! ";

describe("Sarvam TTS adapter (contract-tested; no live call)", () => {
  it("builds the documented request: pinned endpoint, key header, WAV codec, Tamil", async () => {
    const fetchMock = vi.fn(async () => ok(makePcmWav(1200)));
    const result = await synthesizeSarvamSpeech({ text: "முருகா வேல்", speaker: "shubh", pace: 1 }, {}, { fetch: fetchMock, apiKey: "test-key" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(SARVAM_TTS_URL);
    expect((init.headers as Record<string, string>)["api-subscription-key"]).toBe("test-key");
    expect(init.redirect).toBe("error");
    expect(JSON.parse(init.body as string)).toEqual({ text: "முருகா வேல்", language_code: "ta-IN", model: "bulbul:v3", output_audio_codec: "wav", speech_sample_rate: 24000, speaker: "shubh", pace: 1 });
    expect(result.durationMs).toBe(1200);
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.providerRequestIds).toEqual(["req-1"]);
  });

  it("chunks long Tamil text under the model limit and assembles one WAV", async () => {
    const text = TAMIL.repeat(120);
    const chunks = chunkSpeechText(text, 2500);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every(chunk => chunk.length <= 2500)).toBe(true);
    expect(chunks.join(" ").replace(/\s+/g, " ")).toBe(text.replace(/\s+/g, " ").trim());
    const fetchMock = vi.fn(async () => ok(makePcmWav(1000)));
    const progress = vi.fn();
    const result = await synthesizeSarvamSpeech({ text }, { onProgress: progress }, { fetch: fetchMock, apiKey: "k" });
    expect(fetchMock).toHaveBeenCalledTimes(chunks.length);
    expect(result.chunkCount).toBe(chunks.length);
    expect(parseWav(result.wav).durationMs).toBe(chunks.length * 1000);
    expect(progress).toHaveBeenLastCalledWith({ stage: "synthesize", completed: chunks.length, total: chunks.length, percent: 100 });
  });

  it("splits a single over-long unbroken word without cutting inside a grapheme cluster", () => {
    const word = "கந்தன்".repeat(900);
    const chunks = chunkSpeechText(word, 1500);
    expect(chunks.every(chunk => chunk.length <= 1500)).toBe(true);
    expect(chunks.join("")).toBe(word);
    expect(chunks.every(chunk => !/^[ா-்]/.test(chunk))).toBe(true); // never starts with a dependent vowel sign/pulli
  });

  it("validates every chunk before the first billable call", async () => {
    const fetchMock = vi.fn();
    await expect(synthesizeSarvamSpeech({ text: "வேல்", pace: 9 }, {}, { fetch: fetchMock as never, apiKey: "k" })).rejects.toMatchObject({ code: "SPEECH_PACE_INVALID" });
    await expect(synthesizeSarvamSpeech({ text: "வேல்", speaker: "Bad Speaker!" }, {}, { fetch: fetchMock as never, apiKey: "k" })).rejects.toMatchObject({ code: "SPEECH_SPEAKER_INVALID" });
    expect(() => buildSarvamTtsPayload({ text: "x", model: "bulbul:v9" as never }, "x")).toThrow(SpeechProviderError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed without a dedicated key", async () => {
    const prior = process.env.CREATOR_TTS_SARVAM_API_KEY;
    delete process.env.CREATOR_TTS_SARVAM_API_KEY;
    try {
      await expect(synthesizeSarvamSpeech({ text: "வேல்" }, {}, { fetch: vi.fn() as never })).rejects.toMatchObject({ code: "SPEECH_PROVIDER_NOT_CONFIGURED", failureClass: "AUTH" });
    } finally {
      if (prior !== undefined) process.env.CREATOR_TTS_SARVAM_API_KEY = prior;
    }
  });

  it.each([[401, "AUTH", false], [402, "QUOTA", false], [429, "RATE_LIMIT", true], [500, "PROVIDER_UNAVAILABLE", true], [422, "INVALID_REQUEST", false]])(
    "classifies HTTP %i as %s (retryable=%s) without leaking the body",
    async (status, failureClass, retryable) => {
      const fetchMock = vi.fn(async () => new Response("secret-account-detail echo of request text", { status }));
      const error = await synthesizeSarvamSpeech({ text: "வேல்" }, {}, { fetch: fetchMock, apiKey: "k" }).catch(e => e);
      expect(error).toBeInstanceOf(SpeechProviderError);
      expect(error).toMatchObject({ failureClass, retryable, code: `SPEECH_PROVIDER_HTTP_${status}` });
      expect(String(error.message)).not.toContain("secret-account-detail");
    },
  );

  it("rejects a non-WAV provider payload instead of persisting it", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ audios: [Buffer.from("junk-not-riff-data-junk-not-riff-data-junk-not-riff").toString("base64")] }), { status: 200 }));
    await expect(synthesizeSarvamSpeech({ text: "வேல்" }, {}, { fetch: fetchMock, apiKey: "k" })).rejects.toMatchObject({ code: "SPEECH_WAV_INVALID" });
  });

  it("cancels between chunks without further provider calls", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async () => { controller.abort(); return ok(makePcmWav(500)); });
    const error = await synthesizeSarvamSpeech({ text: TAMIL.repeat(120) }, { signal: controller.signal }, { fetch: fetchMock, apiKey: "k" }).catch(e => e);
    expect(error).toMatchObject({ code: "SPEECH_CANCELLED", failureClass: "CANCELLED", retryable: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("maps a network failure to a retryable NETWORK error", async () => {
    const fetchMock = vi.fn(async () => { throw new TypeError("fetch failed"); });
    await expect(synthesizeSarvamSpeech({ text: "வேல்" }, {}, { fetch: fetchMock, apiKey: "k" })).rejects.toMatchObject({ failureClass: "NETWORK", retryable: true });
  });
});
