/**
 * Exact output-object identity for fenced Creator renders.
 *
 * The existing storagePut() appends an eight-hex random suffix to every key
 * to avoid overwriting previous uploads. The fenced finalizer must accept
 * that real S3 key, not just the unsuffixed key used by test fixtures.
 *
 * This is an identity check, NOT proof of stored bytes: callers must still
 * perform bounded HTTP 206 readback with exact size and SHA-256.
 */
export type CreatorRenderStorageIdentity = {
  workspaceId: number;
  creatorProjectId: number;
  timelineId: number;
  exportId: number;
};

export function assertCreatorRenderStorageKey(
  key: string,
  identity: CreatorRenderStorageIdentity,
): void {
  // Callers may pass a wider render-claim scope (mode/fingerprint) via
  // object spread. Validate ONLY the four numeric storage identity fields;
  // rejecting extra nonnumeric metadata previously broke all real MySQL
  // finalizations before checksum verification or source-drift fencing.
  const ids = [identity.workspaceId, identity.creatorProjectId, identity.timelineId, identity.exportId];
  if (!ids.every(value => Number.isSafeInteger(value) && value > 0) ||
      typeof key !== "string") {
    throw new Error("CREATOR_RENDER_OUTPUT_IDENTITY_INVALID");
  }
  const base = `creator/${identity.workspaceId}/${identity.creatorProjectId}/renders/timeline-${identity.timelineId}/export-${identity.exportId}`;
  const canonical = `${base}.mp4`;
  // Suffix is produced by storagePut(): crypto.randomUUID(), stripped of
  // hyphens, first eight lowercase hexadecimal characters.
  const suffixed = key.startsWith(`${base}_`) &&
    key.endsWith(".mp4") &&
    /^[a-f0-9]{8}$/.test(key.slice(base.length + 1, -4));
  if (key !== canonical && !suffixed) {
    throw new Error("CREATOR_RENDER_OUTPUT_IDENTITY_INVALID");
  }
}
