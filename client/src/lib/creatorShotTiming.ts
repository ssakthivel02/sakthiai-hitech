/** Validate absolute shot timing before sending it to the Creator project API.
 * The server enforces the same nonnegative/increasing integral bounds.
 */
export function isValidCreatorShotTiming(startMs: number, endMs: number): boolean {
  return Number.isSafeInteger(startMs) && Number.isSafeInteger(endMs) &&
    startMs >= 0 && endMs > startMs;
}
