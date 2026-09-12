import { describe, expect, it } from "vitest";
import { parseWavDurationMs, validateCaptionCues } from "./audioMaster";

function pcmWav(durationMs: number, sampleRate = 8000, channels = 1, bitsPerSample = 16) {
  const bytesPerSample = bitsPerSample / 8;
  const dataBytes = Math.round((durationMs / 1000) * sampleRate * channels * bytesPerSample);
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  const byteRate = sampleRate * channels * bytesPerSample;
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(channels * bytesPerSample, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);
  return buffer;
}

describe("Creator audio master", () => {
  it("extracts deterministic PCM WAV duration", () => {
    expect(parseWavDurationMs(pcmWav(2500))).toBe(2500);
  });

  it("rejects malformed or truncated WAV input", () => {
    expect(() => parseWavDurationMs(Buffer.from("not-wave"))).toThrow("CREATOR_AUDIO_INVALID_WAV");
    const truncated = pcmWav(1000).subarray(0, 50);
    expect(() => parseWavDurationMs(truncated)).toThrow("CREATOR_AUDIO_TRUNCATED_WAV");
  });

  it("accepts ordered Tamil cues bounded by the approved audio master", () => {
    const cues = validateCaptionCues(
      [
        { startMs: 0, endMs: 1200, text: "முருகா..." },
        { startMs: 1400, endMs: 2800, text: "என் முருகா..." },
      ],
      3000,
    );
    expect(cues).toEqual([
      { startMs: 0, endMs: 1200, text: "முருகா...", language: "ta" },
      { startMs: 1400, endMs: 2800, text: "என் முருகா...", language: "ta" },
    ]);
  });

  it("rejects overlap, inverted ranges and cues beyond audio duration", () => {
    expect(() => validateCaptionCues([
      { startMs: 0, endMs: 1500, text: "அருள்" },
      { startMs: 1400, endMs: 2000, text: "வேல்" },
    ], 3000)).toThrow("CREATOR_CAPTION_OVERLAP");

    expect(() => validateCaptionCues([{ startMs: 1000, endMs: 900, text: "முருகா" }], 3000))
      .toThrow("CREATOR_CAPTION_RANGE_INVALID");

    expect(() => validateCaptionCues([{ startMs: 2500, endMs: 3200, text: "முருகா" }], 3000))
      .toThrow("CREATOR_CAPTION_OUTSIDE_AUDIO_MASTER");
  });

  it("rejects empty cues and invalid master duration", () => {
    expect(() => validateCaptionCues([{ startMs: 0, endMs: 500, text: "   " }], 1000))
      .toThrow("CREATOR_CAPTION_TEXT_REQUIRED");
    expect(() => validateCaptionCues([], 0)).toThrow("CREATOR_AUDIO_DURATION_INVALID");
  });
});
