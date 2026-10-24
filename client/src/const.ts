import { OAUTH_PKCE_COOKIE, OAUTH_STATE_COOKIE, encodeOAuthState } from "@shared/const";

export { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";

/**
 * Start a provider-neutral OIDC Authorization Code login.
 *
 * The one-time nonce cookie binds the callback to the browser that initiated
 * the login, and an S256 PKCE verifier (single-use cookie) binds the code to this
 * transaction. The backend exchanges the authorization code server-side.
 * `returnTo` is a same-site relative path; the server re-validates it.
 */
const base64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export const startLogin = async (returnTo?: string) => {
  const authorizationUrl = import.meta.env.VITE_OIDC_AUTHORIZATION_URL;
  const clientId = import.meta.env.VITE_OIDC_CLIENT_ID ?? import.meta.env.VITE_APP_ID;
  const scopes = import.meta.env.VITE_OIDC_SCOPES ?? "openid profile email";

  if (!authorizationUrl || !clientId) {
    throw new Error("OIDC login is not configured");
  }

  const redirectUri = `${window.location.origin}/api/oauth/callback`;
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32))); // 43 chars, RFC 7636
  const challenge = base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  // The nonce is issued by the server (stored in the shared database, bound to this challenge, 10-minute lifetime).
  const begin = await fetch("/api/oauth/begin", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ challenge }),
  });
  if (!begin.ok) throw new Error(`Login could not be started (${begin.status})`);
  const { nonce } = (await begin.json()) as { nonce: string };
  document.cookie = `${OAUTH_STATE_COOKIE}=${nonce}; Path=/; Max-Age=600; SameSite=Lax; Secure`;
  document.cookie = `${OAUTH_PKCE_COOKIE}=${verifier}; Path=/; Max-Age=600; SameSite=Lax; Secure`;
  const state = encodeOAuthState({ redirectUri, nonce, challenge, ...(returnTo ? { returnTo } : {}) });

  const url = new URL(authorizationUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", scopes);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");

  window.location.href = url.toString();
};
