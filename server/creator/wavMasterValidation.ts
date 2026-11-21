/**
 * Strict PCM RIFF/WAVE acceptance for immutable Creator audio masters.
 * Unlike streaming/TTS WAV readers, a human-approved master must have an
 * exact, complete container so subtitle timing cannot be derived from a lie.
 */
export function parseWavDurationMs(buffer: Buffer): number {
  if (buffer.length < 44 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("CREATOR_AUDIO_INVALID_WAV");
  }

  const declaredEnd = buffer.readUInt32LE(4) + 8;
  if (declaredEnd > buffer.length) throw new Error("CREATOR_AUDIO_TRUNCATED_WAV");
  if (declaredEnd !== buffer.length) throw new Error("CREATOR_AUDIO_INVALID_RIFF_LENGTH");

  let offset = 12;
  let byteRate: number | undefined;
  let blockAlign: number | undefined;
  let dataBytes: number | undefined;

  while (offset < declaredEnd) {
    if (offset + 8 > declaredEnd) throw new Error("CREATOR_AUDIO_TRUNCATED_WAV");
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    const next = body + size + (size % 2);
    if (next > declaredEnd) throw new Error("CREATOR_AUDIO_TRUNCATED_WAV");

    if (id === "fmt ") {
      if (byteRate !== undefined || size < 16) throw new Error("CREATOR_AUDIO_INVALID_WAV_FMT");
      const encoding = buffer.readUInt16LE(body);
      const channels = buffer.readUInt16LE(body + 2);
      const sampleRate = buffer.readUInt32LE(body + 4);
      const declaredByteRate = buffer.readUInt32LE(body + 8);
      const declaredBlockAlign = buffer.readUInt16LE(body + 12);
      const bitsPerSample = buffer.readUInt16LE(body + 14);
      if (encoding !== 1) throw new Error("CREATOR_AUDIO_UNSUPPORTED_WAV_ENCODING");
      if (channels < 1 || channels > 8 || sampleRate < 8000 || sampleRate > 192000 || ![8, 16, 24, 32].includes(bitsPerSample)) {
        throw new Error("CREATOR_AUDIO_UNSUPPORTED_WAV_FORMAT");
      }
      const expectedBlockAlign = channels * (bitsPerSample / 8);
      if (declaredBlockAlign !== expectedBlockAlign) throw new Error("CREATOR_AUDIO_INVALID_BLOCK_ALIGN");
      const expectedByteRate = sampleRate * expectedBlockAlign;
      if (declaredByteRate !== expectedByteRate) throw new Error("CREATOR_AUDIO_INVALID_BYTE_RATE");
      blockAlign = expectedBlockAlign;
      byteRate = expectedByteRate;
    } else if (id === "data") {
      if (dataBytes !== undefined) throw new Error("CREATOR_AUDIO_DUPLICATE_DATA_CHUNK");
      dataBytes = size;
    }
    offset = next;
  }

  if (byteRate === undefined || blockAlign === undefined || dataBytes === undefined) {
    throw new Error("CREATOR_AUDIO_WAV_CHUNKS_MISSING");
  }
  if (dataBytes === 0 || dataBytes % blockAlign !== 0) throw new Error("CREATOR_AUDIO_INVALID_PCM_LENGTH");
  return Math.max(1, Math.round((dataBytes / byteRate) * 1000));
}
