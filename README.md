# SakthiAI Hi-Tech

This repository is the canonical source for the new SakthiAI Hi-Tech website/runtime. It is a full-stack application: React/Vite frontend plus an Express/tRPC backend.

## Current functional boundary

The backend owns authenticated workspaces, projects, private document upload, PDF/DOCX/text extraction, retrieval, embeddings, grounded chat, citations, durable conversations, database access, and object-storage mediation. These capabilities require a backend runtime and are not suitable for static-only hosting.

## Provider-neutral runtime completed

- Manus Vite runtime/debug instrumentation removed.
- Browser Manus debug collector removed.
- `vite-plugin-manus-runtime` removed from both manifest and lockfile.
- Package identity normalized to `sakthiai-hitech`.
- Core LLM client targets an explicit OpenAI-compatible `LLM_API_URL`.
- Core object storage uses generic S3-compatible configuration and `/api/storage/*`.
- Authentication uses a provider-neutral OAuth 2.0 / OIDC authorization-code adapter and SakthiAI-owned application sessions.
- Core frontend auth no longer writes preview/session artifacts from the imported scaffold.
- Unused imported Forge Data API, heartbeat, image, maps, notification, and voice helpers were removed rather than carried into production.
- CI validates production-critical source and scans the compiled `dist/` deployment artifact for prohibited legacy runtime markers.

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

## Validation

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm build
```

GitHub Actions repeats these checks on `main` and pull requests, then scans the deployable artifact. A green build does not by itself mean production-ready: preview runtime provisioning, integration tests, login/API/storage smoke tests, responsive/accessibility/security QA, and exact-deployed-commit validation are still required before custom-domain promotion.
