# SakthiAI Preview Deployment Plan

Status: PREVIEW-READY SOURCE, DEPLOYMENT NOT STARTED

## Approved preview architecture

- Canonical source: GitHub `ssakthivel02/sakthiai-hitech` only.
- Preview web runtime: Render Web Service (Node.js / Express).
- Preview database: Aiven Free MySQL, isolated database `sakthiai_preview` with a dedicated user.
- Preview authentication: provider-neutral OIDC adapter configured against a test OAuth/OIDC client.
- Preview AI: Cloudflare Workers AI through its OpenAI-compatible endpoint, using a model available on the Workers Free plan; no paid provider is enabled.
- Preview object storage: Cloudflare R2 through the existing S3-compatible storage adapter, in a dedicated preview bucket only. R2 is runtime object storage, never canonical source storage.
- Build command: `pnpm install --frozen-lockfile && pnpm build`
- Start command: `pnpm start`
- Health check: `/readyz`
- Production DNS: not attached during preview qualification.

## Required preview runtime values

Core:
- `NODE_ENV=production`
- `JWT_SECRET=<strong random secret>`
- `DATABASE_URL=mysql://<sakthiai-preview-user>:<password>@<host>:<port>/sakthiai_preview?ssl-mode=REQUIRED`

OIDC:
- `OIDC_AUTHORIZATION_URL`
- `OIDC_TOKEN_URL`
- `OIDC_USERINFO_URL`
- `OIDC_CLIENT_ID`
- `OIDC_CLIENT_SECRET` when required
- `OIDC_SCOPES=openid profile email`
- `OIDC_PROVIDER_NAME`

AI:
- `LLM_API_URL=https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/v1`
- `LLM_API_KEY=<least-privilege Workers AI token>`
- `LLM_MODEL=<approved free Workers AI model>`

Storage:
- `STORAGE_ENDPOINT=<R2 S3 endpoint>`
- `STORAGE_REGION=auto`
- `STORAGE_BUCKET=sakthiai-preview`
- `STORAGE_ACCESS_KEY_ID=<preview-only R2 access key>`
- `STORAGE_SECRET_ACCESS_KEY=<preview-only R2 secret>`
- `STORAGE_FORCE_PATH_STYLE=false`

## Hard rules

- `ALLOW_LEGACY_FORGE_RUNTIME` must remain unset/false.
- No Manus/Forge/WebDev auth/runtime endpoint may be introduced.
- No paid AI provider may be enabled without explicit owner approval.
- Preview DB, OIDC client and storage bucket must be isolated from production.
- Secrets must be entered directly in provider dashboards; do not commit or paste them into chat.

## Qualification gate

Preview can advance only when all are true:

1. GitHub quality gate is green on the exact deployed commit.
2. `/healthz` returns alive.
3. `/readyz` confirms DB + OIDC + LLM + storage readiness.
4. Login/callback/session flow works on the preview URL.
5. Workspace creation and tenant isolation work.
6. Upload -> extraction -> chunking -> retrieval -> grounded chat -> citation flow works.
7. Object download proxy works without exposing storage credentials.
8. Desktop/mobile route, link, asset, console, network, accessibility and security smoke tests pass.
9. Only after these checks may custom DNS/HTTPS promotion be considered.

## Manual owner action required

Create the Aiven preview database/user, Render Web Service, test OIDC client, Cloudflare Workers AI token and dedicated R2 preview bucket/token. Share only non-secret status/screenshots in chat; enter all secrets directly into the provider dashboards.
