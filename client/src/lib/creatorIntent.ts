/**
 * Browser-session idempotency for potentially billable Creator submissions.
 * An accepted provider submission is NOT permission to mint a fresh key.
 * Repeat clicks / retries with identical inputs must return the original job.
 * Changing the payload is a new, separately priced user intent.
 */
export type CreatorRequestIntent = { key: string; fingerprint: string; keysByFingerprint?: Record<string, string> };

export function creatorIntentKey(
  intents: Record<string, CreatorRequestIntent>,
  scope: string,
  payload: unknown,
  newKey: () => string,
): string {
  const fingerprint = JSON.stringify(payload);
  const previous = intents[scope];
  if (previous?.fingerprint === fingerprint) return previous.key;
  // Keep all requests seen for this scope, not just the immediately previous one.
  // A -> B -> A must reuse A's original job instead of silently spending again.
  const keysByFingerprint = previous?.keysByFingerprint ?? Object.create(null) as Record<string, string>;
  if (previous) keysByFingerprint[previous.fingerprint] = previous.key;
  const key = Object.prototype.hasOwnProperty.call(keysByFingerprint, fingerprint)
    ? keysByFingerprint[fingerprint]
    : newKey();
  keysByFingerprint[fingerprint] = key;
  intents[scope] = { key, fingerprint, keysByFingerprint };
  return key;
}
