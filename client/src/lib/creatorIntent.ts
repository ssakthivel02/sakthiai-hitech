/**
 * Browser-session idempotency for potentially billable Creator submissions.
 * An accepted provider submission is NOT permission to mint a fresh key.
 * Repeat clicks / retries with identical inputs must return the original job.
 * Changing the payload is a new, separately priced user intent.
 */
export type CreatorRequestIntent = { key: string; fingerprint: string };

export function creatorIntentKey(
  intents: Record<string, CreatorRequestIntent>,
  scope: string,
  payload: unknown,
  newKey: () => string,
): string {
  const fingerprint = JSON.stringify(payload);
  const previous = intents[scope];
  if (previous?.fingerprint === fingerprint) return previous.key;
  const key = newKey();
  intents[scope] = { key, fingerprint };
  return key;
}
