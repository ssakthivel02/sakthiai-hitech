# SakthiAI Hi-Tech

This repository is the canonical source for the new SakthiAI Hi-Tech website/runtime. It is a full-stack application: React/Vite frontend plus an Express/tRPC backend.

## Current functional boundary

The backend owns authenticated workspaces, projects, private document upload, PDF/DOCX/text extraction, retrieval, embeddings, grounded chat, citations, durable conversations, and database access. These capabilities are not suitable for static-only hosting.

## Provider-neutral production work completed

- Manus Vite runtime/debug instrumentation removed from production-critical frontend configuration.
- Browser Manus debug collector removed.
- Core LLM client now targets an explicit OpenAI-compatible `LLM_API_URL`; there is no hardcoded Manus/Forge fallback.
- Core object storage now uses generic S3-compatible configuration rather than Forge presign APIs.
- Storage download proxy is `/api/storage/*`.
- Core frontend auth hook no longer writes Manus preview/session artifacts.
- CI contains a runtime-neutrality guard plus TypeScript, tests, and production build validation.

## Transitional legacy boundary

The imported source still contains helper modules for image generation, maps, notifications, voice/data APIs, and a WebDev OAuth SDK that originated from the Manus/Forge scaffold. Legacy Forge configuration is gated off by default and is available only when `ALLOW_LEGACY_FORGE_RUNTIME=true` is explicitly set. Production must not enable this flag.

Authentication remains the principal provider-specific blocker: the current login/callback SDK still uses the imported WebDev OAuth contract. It must be replaced by a standard provider-neutral OIDC/auth adapter before public production launch.

## Runtime configuration

Copy `.env.example` and supply only the services deliberately selected for deployment. Never commit secrets.

Core production variables include:

- `DATABASE_URL`
- `JWT_SECRET`
- `LLM_API_URL`, optional `LLM_API_KEY`, optional `LLM_MODEL`
- embedding configuration when embeddings are enabled
- S3-compatible `STORAGE_*` settings
- authentication settings after the OIDC/auth migration is completed

## Validation

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm build
```

GitHub Actions repeats these checks on `main` and pull requests. A green build does not by itself mean production-ready: auth replacement, runtime provisioning, deployment, HTTPS, route/API smoke tests, security review, and production QA are still required.
