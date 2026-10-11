/**
 * Session lifetime and secret policy.
 *  - `SESSION_MAX_AGE_DAYS`: whole days, default 30, clamped to 90 (invalid -> default). Applies to new tokens AND is
 *    enforced on every request against the token's `iat`, so tokens issued earlier with a 1-year `exp` are capped too.
 *  - Clock skew tolerated for `iat`: 60 s.
 *  - In a production runtime the HS256 secret must be at least 32 characters (fail closed otherwise).
 */
const DAY_MS = 86_400_000;
export const DEFAULT_SESSION_DAYS = 30;
export const MAX_SESSION_DAYS = 90;
export const IAT_SKEW_SECONDS = 60;
export const MIN_PRODUCTION_SECRET_LENGTH = 32;

type Env = Record<string, string | undefined>;

export function sessionMaxAgeMs(env: Env = process.env): number {
  const raw = env.SESSION_MAX_AGE_DAYS?.trim();
  const days = raw && /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(days) || days < 1) return DEFAULT_SESSION_DAYS * DAY_MS;
  return Math.min(days, MAX_SESSION_DAYS) * DAY_MS;
}

/** `iat` must exist, not be in the future beyond the skew, and be younger than the max age. */
export function isTokenAgeAcceptable(iat: unknown, nowMs: number = Date.now(), env: Env = process.env): boolean {
  if (typeof iat !== "number" || !Number.isFinite(iat)) return false;
  const nowSeconds = Math.floor(nowMs / 1000);
  if (iat > nowSeconds + IAT_SKEW_SECONDS) return false;
  return (nowSeconds - iat) * 1000 <= sessionMaxAgeMs(env);
}

export function assertSessionSecretStrength(secret: string, env: Env = process.env): void {
  if (env.NODE_ENV === "production" && secret.length < MIN_PRODUCTION_SECRET_LENGTH) {
    throw new Error(`JWT_SECRET must be at least ${MIN_PRODUCTION_SECRET_LENGTH} characters in production`);
  }
}
