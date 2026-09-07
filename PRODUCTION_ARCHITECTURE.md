# SakthiAI Hi-Tech — Production Architecture Boundary

Status: ARCHITECTURE_VALIDATED / MANUS_DECOUPLING_IN_PROGRESS / DEPLOYMENT_NOT_YET_APPROVED
Date: 2026-09-07

## Verified current architecture

- React 19 + Vite frontend under `client/`.
- Express + tRPC backend under `server/`.
- Drizzle ORM + MySQL through `DATABASE_URL`.
- Authenticated workspaces/projects/documents/conversations are server-owned.
- File upload validation, PDF/DOCX/text extraction, hashing and persistence are server-owned.
- Storage is server-owned.
- Embeddings/retrieval are server-owned.
- Grounded chat calls the server LLM adapter and persists citations/messages.

## Completed Manus-only frontend cleanup

Removed from `vite.config.ts`:

- `vite-plugin-manus-runtime`
- JSX location instrumentation
- Manus debug collector middleware
- Manus browser log/session replay collection
- Manus preview-domain allow-list entries

Removed:

- `client/public/__manus__/debug-collector.js`

These changes do not alter application routes, tRPC contracts, database operations, retrieval, storage or chat behavior.

## Remaining provider/runtime coupling

The server LLM adapter currently uses Forge-era environment names and falls back to `https://forge.manus.im`.

Current related variables include:

- `BUILT_IN_FORGE_API_URL`
- `BUILT_IN_FORGE_API_KEY`
- `EMBEDDING_API_URL`
- `EMBEDDING_API_KEY`
- `EMBEDDING_PROVIDER`
- `EMBEDDING_MODEL`

The LLM contract must become provider-neutral before production launch. No browser bundle may contain provider credentials.

## Static versus server boundary

### Browser/static-safe

The compiled React UI and public assets can be hosted separately when API origin configuration is explicit.

### Backend-required

- Authentication/session operations.
- Workspace and project ownership checks.
- Database persistence.
- File upload and content validation.
- Document extraction.
- Object storage.
- Embeddings and retrieval.
- Grounded chat and citations.
- LLM invocation.
- Conversation history.

## Hosting decision

Do not deploy SakthiAI as GitHub Pages-only. GitHub Pages can host only the static frontend portion. A production backend/API runtime is mandatory for the current product.

Target architecture:

1. GitHub repository = canonical source.
2. Static frontend = independently deployable web asset where appropriate.
3. Node/Express/tRPC backend = separate runtime.
4. Database, storage, embeddings and LLM credentials = backend only.
5. AI provider layer = provider-neutral adapter with explicit endpoint/key configuration; no Manus default.
6. Cloudflare may later provide DNS/security/proxy functions, not canonical source storage.

## Deployment blockers

- Baseline GitHub Actions quality gate exists but a successful run is not yet evidenced.
- Forge/Manus fallback still exists in server LLM code.
- Production authentication/OAuth target is not finalized.
- Production database target is not configured.
- Production storage adapter/credentials are not configured.
- Embedding provider/runtime is not finalized.
- Production CORS/cookie/origin policy is not finalized.
- Exact deployed commit has not passed end-to-end browser validation.

## Current gate

SOURCE: PASS
FRONTEND MANUS DEBUG/RUNTIME CLEANUP: PASS
BACKEND MANUS/PROVIDER DECOUPLING: IN PROGRESS
STATIC-ONLY DEPLOYMENT: NO-GO
FULL PRODUCTION DEPLOYMENT: NO-GO pending backend/provider and validation gates
