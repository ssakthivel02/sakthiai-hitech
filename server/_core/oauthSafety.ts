import { createHash, timingSafeEqual } from "node:crypto";
import type { Request } from "express";
import { ENV } from "./env";

export const OAUTH_CALLBACK_PATH = "/api/oauth/callback";
const MAX_STATE_LENGTH = 2048;
const MAX_RETURN_TO_LENGTH = 512;
const PKCE_VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/; // RFC 7636 section 4.1
const PLACEHOLDER_ORIGIN = "http://sakthiai.invalid";

export function isAcceptableStateLength(state: string): boolean {
  return state.length > 0 && state.length <= MAX_STATE_LENGTH;
}

export function isValidPkceVerifier(value: unknown): value is string {
  return typeof value === "string" && PKCE_VERIFIER.test(value);
}

/** RFC 7636 S256: BASE64URL(SHA256(ASCII(verifier))), no padding. */
export function pkceS256Challenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function decodedFixpoint(value: string): string | null {
  // Fully percent-decode (bounded) so single/double/triple encodings are all judged in their final form.
  let current = value;
  for (let i = 0; i < 4; i += 1) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      return null;
    }
    if (next === current) return current;
    current = next;
  }
  return null; // still decoding after 4 rounds: reject rather than guess
}

/**
 * Allowlist policy for the post-login destination. The result is ALWAYS a relative
 * application path ("/..."), never an absolute URL:
 *
 *  - a string of at most 512 chars, no control chars or backslashes, in any decoding;
 *  - it must be an absolute-path reference ("/x"), not scheme-relative ("//x") in any decoding;
 *  - it must resolve to the same (placeholder) origin as a base URL, so any scheme or host fails;
 *  - an absolute http(s) URL is accepted only when its origin is exactly `allowedOrigin`,
 *    and is then reduced to its path;
 *  - anything else falls back to "/".
 */
export function resolvePostLoginPath(raw: unknown, allowedOrigin?: string): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_RETURN_TO_LENGTH) return "/";

  let candidate = raw;
  if (!candidate.startsWith("/")) {
    // Absolute URL: only the server's own origin is permitted, and only its path is kept.
    if (!allowedOrigin) return "/";
    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      return "/";
    }
    if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.origin !== allowedOrigin) return "/";
    if (parsed.username || parsed.password) return "/";
    candidate = `${parsed.pathname}${parsed.search}${parsed.hash}`;
  }

  const decoded = decodedFixpoint(candidate);
  if (decoded === null) return "/";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(candidate) || /[\u0000-\u001f\u007f\\]/.test(decoded)) return "/";
  if (!candidate.startsWith("/") || candidate.startsWith("//") || decoded.startsWith("//")) return "/";
  // A decoded path whose first segment looks like a scheme/host ("/https://x") is still a path, but
  // we refuse it because some intermediaries normalise it into a different destination.
  if (/^\/+[a-z][a-z0-9+.-]*:/i.test(decoded) || /^\/+[^/?#]*@/.test(decoded)) return "/";

  let resolved: URL;
  try {
    resolved = new URL(candidate, PLACEHOLDER_ORIGIN);
  } catch {
    return "/";
  }
  if (resolved.origin !== PLACEHOLDER_ORIGIN) return "/";
  const path = `${resolved.pathname}${resolved.search}${resolved.hash}`;
  if (!path.startsWith("/") || path.startsWith("//")) return "/";
  return path;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/**
 * The only redirect_uri the server will ever send to the token endpoint. The client-supplied
 * value in `state` is accepted solely if it equals the server's own callback URL:
 *  - ENV.oidcRedirectUri when configured (exact match), otherwise
 *  - https://<this request's Host>/api/oauth/callback (http only for loopback outside production),
 *    with no userinfo, query or fragment.
 * Returns the canonical value, or null when the state's value is not acceptable.
 */
export function resolveCallbackRedirectUri(claimed: unknown, req: Pick<Request, "headers">): string | null {
  if (typeof claimed !== "string" || claimed.length === 0 || claimed.length > 512) return null;

  if (ENV.oidcRedirectUri) return claimed === ENV.oidcRedirectUri ? ENV.oidcRedirectUri : null;

  const host = req.headers.host;
  if (typeof host !== "string" || host.length === 0 || /[\s/\\@?#]/.test(host)) return null;
  let parsed: URL;
  try {
    parsed = new URL(claimed);
  } catch {
    return null;
  }
  const secure = parsed.protocol === "https:";
  const loopbackHttp = parsed.protocol === "http:" && !ENV.isProduction && isLoopbackHost(parsed.hostname);
  if (!secure && !loopbackHttp) return null;
  if (parsed.host.toLowerCase() !== host.toLowerCase()) return null;
  if (parsed.pathname !== OAUTH_CALLBACK_PATH || parsed.search || parsed.hash || parsed.username || parsed.password) return null;
  if (claimed !== `${parsed.protocol}//${parsed.host}${OAUTH_CALLBACK_PATH}`) return null; // no alternate spellings
  return claimed;
}

/** Remembers consumed OAuth transactions (by nonce) for their lifetime so a replayed callback is refused. */
export class OAuthTransactionLedger {
  private readonly consumed = new Map<string, number>();
  constructor(private readonly ttlMs = 15 * 60 * 1000, private readonly now: () => number = Date.now) {}

  /** True the first time a nonce is seen, false on replay. */
  consume(nonce: string): boolean {
    const now = this.now();
    for (const [key, expiresAt] of this.consumed) if (expiresAt <= now) this.consumed.delete(key);
    if (this.consumed.has(nonce)) return false;
    this.consumed.set(nonce, now + this.ttlMs);
    return true;
  }
}
