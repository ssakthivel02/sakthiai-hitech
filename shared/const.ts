export const COOKIE_NAME = "app_session_id";
export const ONE_YEAR_MS = 1000 * 60 * 60 * 24 * 365;
export const AXIOS_TIMEOUT_MS = 30_000;
export const UNAUTHED_ERR_MSG = 'Please login (10001)';
export const NOT_ADMIN_ERR_MSG = 'You do not have required permission (10002)';

// One-time nonce cookie that binds an OAuth login to the browser that started
// it. The `__Host-` prefix forces the cookie host-only (Secure, Path=/, no
// Domain), so a sibling *.manus.space site cannot plant a matching value in a
// victim's browser.
export const OAUTH_STATE_COOKIE = "__Host-oauth_state";

// PKCE (RFC 7636, S256) verifier cookie. Same host-only `__Host-` protections as
// the nonce cookie; consumed (cleared) by the callback so it is single-use.
export const OAUTH_PKCE_COOKIE = "__Host-oauth_pkce";

// `state` carries the callback redirect URI, the CSRF nonce, the S256 PKCE
// challenge and an optional post-login destination (`returnTo`).
// Everything in it is CLIENT-CONTROLLED until validated: the server accepts
// `redirectUri` only if it equals the server's own callback URL, and `returnTo`
// only as a same-site relative path (see server/_core/oauthSafety.ts).
// Defined here so the client encoder and server decoder never drift.
export type OAuthState = { redirectUri: string; nonce?: string; challenge?: string; returnTo?: string };

export const encodeOAuthState = (state: OAuthState): string =>
  btoa(JSON.stringify(state));

export const decodeOAuthState = (state: string): OAuthState => {
  let decoded: string;
  try {
    decoded = atob(state);
  } catch {
    // Malformed base64 (e.g. attacker-supplied garbage). Return no nonce so the
    // callback's CSRF guard rejects it with 403 — never throw, since the caller
    // runs outside the request handler's try/catch.
    return { redirectUri: "" };
  }
  try {
    const parsed = JSON.parse(decoded);
    if (parsed && typeof parsed.redirectUri === "string") return parsed;
  } catch {
    // Legacy links: `state` was a bare base64(redirectUri) with no nonce.
  }
  return { redirectUri: decoded };
};
