# SakthiAI Preview Runtime Readiness

## Purpose

This contract defines the minimum runtime configuration required before a SakthiAI preview deployment may be called ready. GitHub remains the canonical source repository. A preview deployment must run the built Express/tRPC application; GitHub Pages alone is not sufficient for the current full-stack product.

## Required preview configuration

### Core
- `NODE_ENV=production`
- `JWT_SECRET` — long random session-signing secret
- `DATABASE_URL` — dedicated preview database, not production
- `OWNER_OPEN_ID` — owner identity subject when owner/admin bootstrap is needed

### OIDC / OAuth 2.0
- `OIDC_AUTHORIZATION_URL`
- `OIDC_TOKEN_URL`
- `OIDC_USERINFO_URL`
- `OIDC_CLIENT_ID`
- `OIDC_CLIENT_SECRET` when required by the selected provider
- `OIDC_SCOPES=openid profile email`
- `OIDC_PROVIDER_NAME`
- browser build variable `VITE_OIDC_AUTHORIZATION_URL`
- browser build variable `VITE_OIDC_CLIENT_ID`
- browser build variable `VITE_OIDC_SCOPES`

The provider callback/redirect URI must be registered as:

`https://<preview-host>/api/oauth/callback`

### LLM
- `LLM_API_URL`
- `LLM_API_KEY` when required by the provider
- `LLM_MODEL`

The endpoint must be OpenAI-compatible. Do not configure a Manus/Forge fallback.

### Object storage
- `STORAGE_ENDPOINT` when required by the S3-compatible provider
- `STORAGE_REGION`
- `STORAGE_BUCKET`
- `STORAGE_ACCESS_KEY_ID`
- `STORAGE_SECRET_ACCESS_KEY`
- `STORAGE_FORCE_PATH_STYLE` where required

### Optional / feature-dependent
- `EMBEDDING_API_URL`
- `EMBEDDING_API_KEY`
- `EMBEDDING_PROVIDER`
- `EMBEDDING_MODEL`

## Runtime gates

- `/healthz` = process liveness only.
- `/readyz` = readiness gate. It must return HTTP 200 before preview QA starts.
- Readiness requires database + OIDC + LLM + storage configuration.
- Embeddings and malware/document scanner status are reported separately.
- No preview may be promoted while `/readyz` returns HTTP 503.

## Preview QA after readiness

Run login/callback/session/logout, workspace isolation, project creation, document upload, retrieval/grounded chat, citation rendering, mobile/desktop navigation, console/network checks, accessibility smoke checks, direct-route refresh, and failure-state tests.

## Prohibited preview shortcuts

- Do not use Manus preview runtime as a hidden dependency.
- Do not use GitHub Pages as the only runtime for this full-stack application.
- Do not point preview tests at the production database.
- Do not commit secrets to GitHub.
- Do not configure custom production DNS until preview QA passes.
