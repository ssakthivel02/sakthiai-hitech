/** Claiming a shot in a Creator timeline must not forge shot provenance from another
 * project/workspace. The caller loads valid IDs using a tenant+project-scoped query.
 * Unbound montage assets are allowed; bound assets must match the claimed shot.
 */
export function requestedTimelineShotIds(items: ReadonlyArray<{ shotId?: number | null }>): number[] {
  const ids = new Set<number>();
  for (const item of items) {
    if (item.shotId == null) continue;
    if (!Number.isSafeInteger(item.shotId) || item.shotId <= 0) {
      throw new Error("CREATOR_TIMELINE_SHOT_ID_INVALID");
    }
    ids.add(item.shotId);
  }
  return [...ids];
}

export function assertTimelineShotAttribution(
  item: { shotId?: number | null },
  asset: { shotId?: number | null },
  scopedShotIds: ReadonlySet<number>,
): void {
  if (item.shotId == null) return;
  if (!Number.isSafeInteger(item.shotId) || item.shotId <= 0) {
    throw new Error("CREATOR_TIMELINE_SHOT_ID_INVALID");
  }
  if (!scopedShotIds.has(item.shotId)) {
    throw new Error("CREATOR_TIMELINE_SHOT_NOT_FOUND");
  }
  if (asset.shotId != null && asset.shotId !== item.shotId) {
    throw new Error("CREATOR_TIMELINE_SHOT_ASSET_MISMATCH");
  }
}
