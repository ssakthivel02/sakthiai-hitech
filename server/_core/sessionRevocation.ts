export const SESSION_GENERATION_SECONDS = 1_000;

export function sessionGenerationFromDate(value: Date | null | undefined): number | null {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return null;
  return Math.floor(value.getTime() / SESSION_GENERATION_SECONDS);
}

export function isSessionGenerationCurrent(
  tokenGeneration: number | null | undefined,
  persistedGenerationDate: Date | null | undefined,
): boolean {
  if (!Number.isSafeInteger(tokenGeneration) || (tokenGeneration ?? -1) < 0) return false;
  const persistedGeneration = sessionGenerationFromDate(persistedGenerationDate);
  return persistedGeneration !== null && tokenGeneration === persistedGeneration;
}

/**
 * Advances the persisted session generation monotonically even when multiple
 * security events happen within the same database timestamp second.
 */
export function nextSessionGenerationDate(
  previous: Date | null | undefined,
  nowMs = Date.now(),
): Date {
  const previousGeneration = sessionGenerationFromDate(previous) ?? -1;
  const nowGeneration = Math.floor(nowMs / SESSION_GENERATION_SECONDS);
  const nextGeneration = Math.max(nowGeneration, previousGeneration + 1);
  return new Date(nextGeneration * SESSION_GENERATION_SECONDS);
}
