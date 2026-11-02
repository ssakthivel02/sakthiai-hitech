import { describe, expect, it } from "vitest";
import { assembleWavParts, makePcmWav, parseWav } from "./wav";

describe("speech wav", () => {
  it("parses duration from PCM byte counts", () => {
    expect(parseWav(makePcmWav(1500)).durationMs).toBe(1500);
  });

  it("assembles parts with exact, audio-derived timings including the gap", () => {
    const out = assembleWavParts([{ id: "a", wav: makePcmWav(1000) }, { id: "b", wav: makePcmWav(2500) }, { id: "c", wav: makePcmWav(500) }], 400);
    expect(out.timings).toEqual([
      { id: "a", startMs: 0, endMs: 1000 },
      { id: "b", startMs: 1400, endMs: 3900 },
      { id: "c", startMs: 4300, endMs: 4800 },
    ]);
    expect(parseWav(out.wav).durationMs).toBe(out.durationMs);
    expect(out.durationMs).toBe(4800);
  });

  it("refuses mixed formats, empty input, bad gaps and non-WAV bytes", () => {
    expect(() => assembleWavParts([{ id: "a", wav: makePcmWav(100, 24000) }, { id: "b", wav: makePcmWav(100, 16000) }])).toThrow("SPEECH_WAV_FORMAT_MISMATCH");
    expect(() => assembleWavParts([])).toThrow("SPEECH_WAV_PARTS_REQUIRED");
    expect(() => assembleWavParts([{ id: "a", wav: makePcmWav(100) }], -1)).toThrow("SPEECH_WAV_GAP_INVALID");
    expect(() => parseWav(Buffer.from("not a wav file at all, definitely not riff data......."))).toThrow("SPEECH_WAV_INVALID");
  });
});
