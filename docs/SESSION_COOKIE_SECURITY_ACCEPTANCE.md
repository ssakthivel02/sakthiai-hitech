# Session Cookie Security Acceptance

## Scope

This control hardens the long-lived authenticated SakthiAI session cookie without changing the OIDC authorization-code/state flow.

## Required behavior

- Session cookies are `HttpOnly`.
- Session cookies are host-only (no `Domain` attribute).
- Session cookies use `Path=/`.
- Session cookies use `SameSite=Lax`; the current OIDC provider returns through a top-level GET callback, so `SameSite=None` is not required for the authenticated session cookie.
- Production session cookies are always `Secure`, independent of caller-supplied forwarding headers.
- Direct HTTPS development/test requests may also receive `Secure` cookies.
- `X-Forwarded-Proto` is not treated as trustworthy transport proof by this helper.

## Existing OAuth state protection

The one-time OAuth state cookie remains separate and uses the `__Host-` prefix, `Secure`, `Path=/`, and `SameSite=Lax`. The callback validates its nonce before exchanging the authorization code.

## Evidence boundary

Repository tests prove cookie-option construction only. They do not prove deployed OIDC login, browser cookie acceptance, session revocation, session rotation, logout invalidation, CSRF resistance for every future state-changing endpoint, reverse-proxy configuration, or penetration-test completion.

Controlled-preview auth acceptance still requires a real login/logout exercise against the exact deployed SHA and browser inspection of the actual `Set-Cookie` behavior.
