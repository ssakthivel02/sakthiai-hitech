import { describe, expect, it } from "vitest";
import { parseWavDurationMs } from "./wavMasterValidation";

function pcmWav(dataBytes = 16000): Buffer {
  const wav = Buffer.alloc(44 + dataBytes + (dataBytes % 2));
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24);
  wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(dataBytes, 40);
  return wav;
}

function withChunk(id: string, bytes: Buffer): Buffer {
  const original = pcmWav();
  const chunk = Buffer.alloc(8 + bytes.length + (bytes.length % 2));
  chunk.write(id, 0, "ascii");
  chunk.writeUInt32LE(bytes.length, 4);
  bytes.copy(chunk, 8);
  const wav = Buffer.concat([original.subarray(0, 36), chunk, original.subarray(36)]);
  wav.writeUInt32LE(wav.length - 8, 4);
  return wav;
}

describe("Creator immutable PCM WAV master strict acceptance", () => {
  it("accepts exact PCM WAV and derives one-second duration", () => {
    expect(parseWavDurationMs(pcmWav())).toBe(1000);
  });
  it("accepts a correctly padded ancillary chunk", () => {
    expect(parseWavDurationMs(withChunk("JUNK", Buffer.from([1, 2, 3])))).toBe(1000);
  });
  it("rejects compressed WAV even if its byte rate looks plausible", () => {
    const wav = pcmWav();
    wav.writeUInt16LE(6, 20);
    expect(() => parseWavDurationMs(wav)).toThrow("CREATOR_AUDIO_UNSUPPORTED_WAV_ENCODING");
  });
  it("rejects IEEE float and extensible format tags without pretending PCM", () => {
    for (const encoding of [3, 0xfffe]) {
      const wav = pcmWav();
      wav.writeUInt16LE(encoding, 20);
      expect(() => parseWavDurationMs(wav)).toThrow("CREATOR_AUDIO_UNSUPPORTED_WAV_ENCODING");
    }
  });
  it("rejects inconsistent byte rate", () => {
    const wav = pcmWav();
    wav.writeUInt32LE(8000, 28);
    expect(() => parseWavDurationMs(wav)).toThrow("CREATOR_AUDIO_INVALID_BYTE_RATE");
  });
  it("rejects inconsistent block alignment", () => {
    const wav = pcmWav();
    wav.writeUInt16LE(4, 32);
    expect(() => parseWavDurationMs(wav)).toThrow("CREATOR_AUDIO_INVALID_BLOCK_ALIGN");
  });
  it("rejects invalid channel count and sample rate", () => {
    const channels = pcmWav();
    channels.writeUInt16LE(0, 22);
    expect(() => parseWavDurationMs(channels)).toThrow("CREATOR_AUDIO_UNSUPPORTED_WAV_FORMAT");
    const rate = pcmWav();
    rate.writeUInt32LE(0, 24);
    expect(() => parseWavDurationMs(rate)).toThrow("CREATOR_AUDIO_UNSUPPORTED_WAV_FORMAT");
  });
  it("rejects unsupported bit depth", () => {
    const wav = pcmWav();
    wav.writeUInt16LE(12, 34);
    expect(() => parseWavDurationMs(wav)).toThrow("CREATOR_AUDIO_UNSUPPORTED_WAV_FORMAT");
  });
  it("rejects data not divisible by PCM frame size", () => {
    const wav = pcmWav(16001);
    expect(() => parseWavDurationMs(wav)).toThrow("CREATOR_AUDIO_INVALID_PCM_LENGTH");
  });
  it("rejects empty PCM payload", () => {
    expect(() => parseWavDurationMs(pcmWav(0))).toThrow("CREATOR_AUDIO_INVALID_PCM_LENGTH");
  });
  it("rejects truncated PCM payload", () => {
    expect(() => parseWavDurationMs(pcmWav().subarray(0, 50))).toThrow("CREATOR_AUDIO_TRUNCATED_WAV");
  });
  it("rejects RIFF length smaller than the actual file", () => {
    const wav = pcmWav();
    wav.writeUInt32LE(36, 4);
    expect(() => parseWavDurationMs(wav)).toThrow("CREATOR_AUDIO_INVALID_RIFF_LENGTH");
  });
  it("rejects a truncated odd-length ancillary chunk padding byte", () => {
    const wav = withChunk("JUNK", Buffer.from([7]));
    const withoutPadding = Buffer.concat([wav.subarray(0, 45), wav.subarray(46)]);
    withoutPadding.writeUInt32LE(withoutPadding.length - 8, 4);
    expect(() => parseWavDurationMs(withoutPadding)).toThrow("CREATOR_AUDIO_TRUNCATED_WAV");
  });
  it("rejects a duplicate data chunk", () => {
    const wav = pcmWav();
    const extra = Buffer.alloc(8);
    extra.write("data", 0, "ascii");
    const duplicate = Buffer.concat([wav, extra]);
    duplicate.writeUInt32LE(duplicate.length - 8, 4);
    expect(() => parseWavDurationMs(duplicate)).toThrow("CREATOR_AUDIO_DUPLICATE_DATA_CHUNK");
  });
  it("rejects missing fmt or data chunks", () => {
    const missingFmt = pcmWav();
    missingFmt.write("JUNK", 12, "ascii");
    expect(() => parseWavDurationMs(missingFmt)).toThrow("CREATOR_AUDIO_WAV_CHUNKS_MISSING");
    const missingData = pcmWav();
    missingData.write("JUNK", 36, "ascii");
    expect(() => parseWavDurationMs(missingData)).toThrow("CREATOR_AUDIO_WAV_CHUNKS_MISSING");
  });
  it("rejects arbitrary non-WAV bytes", () => {
    expect(() => parseWavDurationMs(Buffer.from("not an audio file"))).toThrow("CREATOR_AUDIO_INVALID_WAV");
  });
});
