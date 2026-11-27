/**
 * Audio synchronisation helpers. When the audio master is assembled from per-line audio (assembleWavParts), each line's
 * speech window is known exactly from the PCM data. Captions use that speech window; visuals need a CONTIGUOUS timeline
 * (the renderer rejects gaps), so each silent gap is split at its midpoint between the neighbouring lines' shots.
 */
export type SpeechWindow = { id: string; startMs: number; endMs: number };

export function contiguousVisualWindows(speech: readonly SpeechWindow[], durationMs: number): SpeechWindow[] {
  if (!speech.length) throw new Error("SYNC_WINDOWS_REQUIRED");
  let previousEnd = 0;
  for (const window of speech) {
    if (!(window.startMs >= previousEnd) || !(window.endMs > window.startMs)) throw new Error(`SYNC_WINDOW_INVALID:${window.id}`);
    previousEnd = window.endMs;
  }
  if (previousEnd > durationMs) throw new Error("SYNC_WINDOW_OUTSIDE_AUDIO");
  return speech.map((window, index) => {
    const start = index === 0 ? 0 : Math.round((speech[index - 1].endMs + window.startMs) / 2);
    const end = index === speech.length - 1 ? durationMs : Math.round((window.endMs + speech[index + 1].startMs) / 2);
    return { id: window.id, startMs: start, endMs: end };
  });
}
