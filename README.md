# SakthiAI Hi-Tech

This repository is the canonical source for the new SakthiAI Hi-Tech website/runtime. It is a full-stack application: React/Vite frontend plus an Express/tRPC backend.

## Current functional boundary

The backend owns authenticated workspaces, projects, private document upload, PDF/DOCX/text extraction, retrieval, embeddings, grounded chat, citations, durable conversations, database access, and object-storage mediation. These capabilities require a backend runtime and are not suitable for static-only hosting.

## Provider-neutral runtime completed

- Manus Vite runtime/debug instrumentation removed.
- Browser Manus debug collector removed.
- `vite-plugin-manus-runtime` removed from both the manifest and lockfile.
- Package identity normalized to `sakthiai-hitech`.
- Core LLM client targets an explicit OpenAI-compatible `LLM_API_URL`; no hardcoded Manus/Forge fallback exists in the production-critical path.
- Core object storage uses generic S3-compatible configuration rather than Forge presign APIs.
- Storage download proxy is `/api/storage/*`.
- Authentication uses a provider-neutral OAuth 2.0 / OIDC authorization-code adapter and SakthiAI-owned application sessions.
- Core frontend auth no longer writes Manus preview/session artifacts.
- Legacy Forge runtime remains gated off by default and must not be enabled in production.
- CI contains runtime-neutrality guards plus TypeScript, tests, and production build validation.

## Preview architecture

See `PREVIEW_DEPLOYMENT_PLAN.md`. The first controlled preview is intentionally separated from production DNS and production data. GitHub remains the canonical source.

## Runtime configuration

Copy `.env.example` and supply only deliberately selected deployment services. Never commit secrets.

Core variables include:

- `DATABASE_URL`
- `JWT_SECRET`
- `OIDC_AUTHORIZATION_URL`, `OIDC_TOKEN_URL`, `OIDC_USERINFO_URL`, `OIDC_CLIENT_ID`, and provider-specific secret when required
- `LLM_API_URL`, optional `LLM_API_KEY`, and `LLM_MODEL`
- embedding configuration when enabled
- S3-compatible `STORAGE_*` settings

`ALLOW_LEGACY_FORGE_RUNTIME` must remain unset or false.

## Validation

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm build
```

GitHub Actions repeats these checks on `main` and pull requests. A green build does not by itself mean production-ready: preview runtime provisioning, integration tests, login/API/storage smoke tests, responsive/accessibility/security QA, and exact-deployed-commit validation are still required before custom-domain promotion.
