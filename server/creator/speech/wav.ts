/** Minimal, dependency-free PCM WAV handling for TTS output (no DB/storage imports; safe in any worker). */
export type WavInfo = {
  audioFormat: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  byteRate: number;
  blockAlign: number;
  dataOffset: number;
  dataBytes: number;
  durationMs: number;
};

export function parseWav(buffer: Buffer): WavInfo {
  if (buffer.length < 44 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("SPEECH_WAV_INVALID");
  }
  let offset = 12;
  let fmt: Omit<WavInfo, "dataOffset" | "dataBytes" | "durationMs"> | undefined;
  let dataOffset = -1;
  let dataBytes = -1;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "data") {
      // Streaming encoders may write 0 or 0xFFFFFFFF as the data size; clamp to what is actually present.
      const available = buffer.length - body;
      dataOffset = body;
      dataBytes = size === 0 || size === 0xffffffff || size > available ? available : size;
      break;
    }
    if (body + size > buffer.length) throw new Error("SPEECH_WAV_TRUNCATED");
    if (id === "fmt ") {
      if (size < 16) throw new Error("SPEECH_WAV_INVALID");
      fmt = {
        audioFormat: buffer.readUInt16LE(body),
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        byteRate: buffer.readUInt32LE(body + 8),
        blockAlign: buffer.readUInt16LE(body + 12),
        bitsPerSample: buffer.readUInt16LE(body + 14),
      };
    }
    offset = body + size + (size % 2);
  }
  if (!fmt || dataOffset < 0 || dataBytes <= 0) throw new Error("SPEECH_WAV_CHUNKS_MISSING");
  if (!fmt.byteRate || !fmt.channels || !fmt.sampleRate) throw new Error("SPEECH_WAV_INVALID");
  return { ...fmt, dataOffset, dataBytes, durationMs: Math.max(1, Math.round((dataBytes / fmt.byteRate) * 1000)) };
}

function header(info: Pick<WavInfo, "channels" | "sampleRate" | "bitsPerSample" | "byteRate" | "blockAlign">, dataBytes: number): Buffer {
  const out = Buffer.alloc(44);
  out.write("RIFF", 0, "ascii");
  out.writeUInt32LE(36 + dataBytes, 4);
  out.write("WAVE", 8, "ascii");
  out.write("fmt ", 12, "ascii");
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(info.channels, 22);
  out.writeUInt32LE(info.sampleRate, 24);
  out.writeUInt32LE(info.byteRate, 28);
  out.writeUInt16LE(info.blockAlign, 32);
  out.writeUInt16LE(info.bitsPerSample, 34);
  out.write("data", 36, "ascii");
  out.writeUInt32LE(dataBytes, 40);
  return out;
}

export type WavPart = { id: string; wav: Buffer };
export type AssembledAudio = {
  wav: Buffer;
  durationMs: number;
  /** Exact placement of every part inside the assembled master (derived from the audio itself, never estimated). */
  timings: Array<{ id: string; startMs: number; endMs: number }>;
};

/**
 * Concatenate PCM WAV parts (identical format) with a fixed silence gap between them. Timings are computed from the
 * actual PCM byte counts, so captions derived from them are locked to the audio by construction.
 */
export function assembleWavParts(parts: readonly WavPart[], gapMs = 0): AssembledAudio {
  if (!parts.length) throw new Error("SPEECH_WAV_PARTS_REQUIRED");
  if (!Number.isInteger(gapMs) || gapMs < 0 || gapMs > 10_000) throw new Error("SPEECH_WAV_GAP_INVALID");
  const infos = parts.map(part => parseWav(part.wav));
  const first = infos[0];
  for (const info of infos) {
    if (info.audioFormat !== 1) throw new Error("SPEECH_WAV_UNSUPPORTED_ENCODING");
    if (info.channels !== first.channels || info.sampleRate !== first.sampleRate || info.bitsPerSample !== first.bitsPerSample) {
      throw new Error("SPEECH_WAV_FORMAT_MISMATCH");
    }
  }
  const gapBytes = Math.round((gapMs / 1000) * first.byteRate / first.blockAlign) * first.blockAlign;
  const silence = Buffer.alloc(gapBytes);
  const chunks: Buffer[] = [];
  const timings: AssembledAudio["timings"] = [];
  let cursorBytes = 0;
  parts.forEach((part, index) => {
    const pcm = part.wav.subarray(infos[index].dataOffset, infos[index].dataOffset + infos[index].dataBytes);
    if (index > 0 && gapBytes) { chunks.push(silence); cursorBytes += gapBytes; }
    const startMs = Math.round((cursorBytes / first.byteRate) * 1000);
    chunks.push(pcm);
    cursorBytes += pcm.length;
    timings.push({ id: part.id, startMs, endMs: Math.round((cursorBytes / first.byteRate) * 1000) });
  });
  const wav = Buffer.concat([header(first, cursorBytes), ...chunks]);
  return { wav, durationMs: Math.max(1, Math.round((cursorBytes / first.byteRate) * 1000)), timings };
}

/** Synthetic PCM16 mono tone/silence for tests and fixtures. */
export function makePcmWav(durationMs: number, sampleRate = 24_000, amplitude = 0): Buffer {
  const samples = Math.round((durationMs / 1000) * sampleRate);
  const pcm = Buffer.alloc(samples * 2);
  if (amplitude) for (let i = 0; i < samples; i += 1) pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / sampleRate) * amplitude), i * 2);
  return Buffer.concat([header({ channels: 1, sampleRate, bitsPerSample: 16, byteRate: sampleRate * 2, blockAlign: 2 }, pcm.length), pcm]);
}
