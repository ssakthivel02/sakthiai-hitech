/**
 * Who may sign in (and keep using a session). Provider-neutral: works on the OIDC `sub` and, optionally, on an email
 * the provider asserts as verified.
 *
 *  - `AUTH_OPEN_SIGNUP=true` (exactly): any identity the IdP authenticates (public beta; explicit opt-in).
 *  - `AUTH_ALLOWED_SUBJECTS` (exact OIDC subjects) and/or `AUTH_ALLOWED_EMAILS` (case-insensitive, verified only),
 *    plus `OWNER_OPEN_ID`, which is always admitted: allowlist.
 *  - Nothing configured: closed in a production runtime (NODE_ENV=production, which every deployed tier uses),
 *    open only for local development and tests.
 * Evaluated before the user row is written at login, and again on every authenticated request so removing someone
 * from the allowlist takes effect immediately, not when their token expires.
 */
export type LoginAccessPolicy = {
  mode: "open" | "allowlist" | "closed";
  subjects: ReadonlySet<string>;
  emails: ReadonlySet<string>;
};

export type LoginIdentity = { openId: string; email: string | null; emailVerified: boolean };

type Env = Record<string, string | undefined>;

const list = (raw: string | undefined, normalize: (value: string) => string = value => value) =>
  new Set((raw ?? "").split(",").map(entry => normalize(entry.trim())).filter(Boolean));

export function loginAccessPolicy(env: Env = process.env, production: boolean = env.NODE_ENV === "production"): LoginAccessPolicy {
  const subjects = list(env.AUTH_ALLOWED_SUBJECTS);
  const owner = env.OWNER_OPEN_ID?.trim();
  if (owner) subjects.add(owner);
  const emails = list(env.AUTH_ALLOWED_EMAILS, value => value.toLowerCase());
  if (env.AUTH_OPEN_SIGNUP === "true") return { mode: "open", subjects, emails };
  if (subjects.size || emails.size) return { mode: "allowlist", subjects, emails };
  return { mode: production ? "closed" : "open", subjects, emails };
}

export function isIdentityAllowed(policy: LoginAccessPolicy, identity: LoginIdentity): boolean {
  if (policy.mode === "open") return true;
  if (policy.mode === "closed") return false;
  if (policy.subjects.has(identity.openId)) return true;
  return Boolean(identity.emailVerified && identity.email && policy.emails.has(identity.email.trim().toLowerCase()));
}

/**
 * Session-time access must not promote a persisted email to verified. An OIDC subject
 * can legitimately be allowlisted with an unverified email; after subject removal,
 * the email must NOT silently become a second admission route. Only a verified
 * email snapshot from the server-signed session token can satisfy email allowlisting.
 * The snapshot must still equal the current persisted email, and the current
 * access policy is checked on every request. Older tokens lacking proof fail
 * closed for email-only admission (subject allowlisting still works).
 */
export function isSessionUserAllowed(
  policy: LoginAccessPolicy,
  user: { openId: string; email: string | null },
  verifiedEmailFromSession?: string | null,
): boolean {
  if (policy.mode === "open") return true;
  if (policy.mode === "closed") return false;
  if (policy.subjects.has(user.openId)) return true;
  const verifiedEmail = verifiedEmailFromSession?.trim().toLowerCase();
  return Boolean(verifiedEmail && user.email?.trim().toLowerCase() === verifiedEmail && policy.emails.has(verifiedEmail));
}
