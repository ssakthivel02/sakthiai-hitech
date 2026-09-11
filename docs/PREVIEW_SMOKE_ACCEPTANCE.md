# SakthiAI Preview Smoke Acceptance

This document defines repository-level evidence for the controlled-preview operational contract. It does not claim that a live Render deployment has passed.

## Repository contract

- `/healthz` is liveness-only and must return HTTP 200 with `status: alive`.
- `/readyz` is dependency readiness and must return HTTP 503 when required dependencies are not ready.
- Required readiness dependencies are database, authentication, LLM and storage.
- Scanner readiness is reported separately and may remain `SCANNER_NOT_CONFIGURED`; that state must not be interpreted as secure-upload readiness.
- `/releasez` must expose repository and commit identity. Controlled-preview acceptance requires a known exact deployed commit.
- Render preview must use `/readyz` as the health check and keep automatic deployment disabled.

## Live acceptance still required

Repository CI cannot prove the preview deployment. A live acceptance record must capture, against one exact deployed SHA:

1. `/releasez` repository and commit match the candidate SHA.
2. `/healthz` returns HTTP 200 and `alive`.
3. `/readyz` returns HTTP 200 and `ready` only when required dependencies are genuinely configured; otherwise HTTP 503 is the correct fail-closed result.
4. Operational endpoints return no-store/no-cache behavior as configured by the runtime.
5. A basic application HTTP smoke succeeds on that same deployed SHA.
6. Any failure is recorded as NO-GO rather than converted into a production-ready claim.

Production deployment, DNS promotion and owner approval remain separate gates.
