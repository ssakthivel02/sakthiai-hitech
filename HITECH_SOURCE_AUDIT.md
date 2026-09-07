# SakthiAI Hi-Tech Source Audit

Audit date: 2026-09-07

## Classification

SOURCE_PRESENT — FULL_STACK_WEB / MANUS_COUPLING_PRESENT

## Verified

- Current repository contains editable SakthiAI web source with Vite/React client and Node/Express server runtime.
- `package.json` builds both frontend and server output.
- `vite.config.ts` currently includes `vite-plugin-manus-runtime`, JSX location instrumentation, and a Manus debug collector with Manus preview host allow-list entries.
- Server-side dependencies include database, S3, document/PDF parsing and tRPC-related runtime packages.

## Required remediation before production

- Remove or production-gate Manus-only development/debug/runtime coupling after verifying no user-facing feature depends on it.
- Audit all API/tRPC/server routes before deciding static hosting boundaries.
- Keep GitHub as canonical source; do not use Cloudflare storage as source of truth.
- Separate static frontend deployment from AI/backend runtime where required.
- Never expose secrets in the repository or frontend bundle.

## Gate

DEPLOYMENT_READY: NO
SOURCE_ACCEPTED_FOR_REMEDIATION: YES

No production-ready claim until the exact deployed commit passes build, typecheck, tests, security/dependency review, route/link/asset validation, responsive/accessibility QA, console/network checks, backend/API health checks and HTTPS/custom-domain smoke tests.
