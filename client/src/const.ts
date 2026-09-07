import { OAUTH_STATE_COOKIE, encodeOAuthState } from "@shared/const";

export { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";

/**
 * Start a provider-neutral OIDC Authorization Code login.
 *
 * The one-time nonce cookie binds the callback to the browser that initiated
 * the login. The backend exchanges the authorization code server-side.
 */
export const startLogin = () => {
  const authorizationUrl = import.meta.env.VITE_OIDC_AUTHORIZATION_URL;
  const clientId = import.meta.env.VITE_OIDC_CLIENT_ID ?? import.meta.env.VITE_APP_ID;
  const scopes = import.meta.env.VITE_OIDC_SCOPES ?? "openid profile email";

  if (!authorizationUrl || !clientId) {
    throw new Error("OIDC login is not configured");
  }

  const redirectUri = `${window.location.origin}/api/oauth/callback`;
  const nonce = crypto.randomUUID();
  document.cookie = `${OAUTH_STATE_COOKIE}=${nonce}; Path=/; Max-Age=600; SameSite=Lax; Secure`;
  const state = encodeOAuthState({ redirectUri, nonce });

  const url = new URL(authorizationUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", scopes);
  url.searchParams.set("state", state);

  window.location.href = url.toString();
};
