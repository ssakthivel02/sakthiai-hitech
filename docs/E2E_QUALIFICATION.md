# Production-shaped E2E qualification (Playwright)

`pnpm test:e2e` (needs `TEST_DATABASE_URL`, a local/CI MySQL-compatible server) builds the client with the **fake** OIDC authorize URL baked in, then runs Playwright against the **real built server** (`dist/index.js`) in two projects: `desktop` (1280x800) and `mobile` (Pixel 5). Chromium comes from `PLAYWRIGHT_BROWSERS_PATH` locally; CI runs `playwright install --with-deps chromium`.

## What is real, what is faked
Real: the built Express/tRPC server, the built React client, the migrated database (throwaway `sakthi_it_*` DB), session cookies/JWT/revocation, PKCE + nonce cookies, tenant checks, upload pipeline, retrieval, the Provider Gateway and its policy.
Faked (all loopback, in-process, `e2e/support/fakes.ts`): OIDC provider (enforces S256 PKCE, single-use codes), local OpenAI-compatible LLM (modes `ok` / `insufficient` / `down`), a configured-but-must-never-be-called "external" LLM, path-style S3, and a clamd INSTREAM scanner (flags EICAR).
`NODE_ENV=test` (not production) because the production build rightly rejects a non-https OIDC callback and this stack is plain-http loopback.

## Covered
Login via fake OIDC; honoured same-site `returnTo`; six hostile `returnTo` shapes never leave the origin; callback replay and tampered nonce rejected; UI logout revokes server-side (old cookie replayed in another context is dead); a newer login revokes the older session; two-user workspace isolation (list/chat/upload/project-create FORBIDDEN, no cross-workspace evidence); unauthenticated rejection; upload scanned (clean accepted, EICAR rejected) and listed; English, Tamil and mixed-script grounded chat with citations through the **local** provider; no-evidence INSUFFICIENT_EVIDENCE without any model call; model-declared INSUFFICIENT_EVIDENCE; MODEL_UNAVAILABLE with evidence still listed and **zero external requests** while local is down, then recovery without restart; readiness; keyboard-only navigation with visible focus indicators; critical axe checks (WCAG 2 A/AA) on landing and workspace; no horizontal overflow and reachable controls on both viewports.

## Deliberately not covered
UI file upload: the control is correctly disabled by the owner-approval/runtime-evidence gate in the release contract (the test asserts that), so upload is exercised through the authenticated API. No real IdP, model server, ClamAV, S3, or deployed environment was exercised: RUNTIME_UNVERIFIED for all of them.

## Defects found by this suite (fixed)
At <= 900px the log-out control and name were `display:none`, so narrow-viewport users could not log out or revoke their session; and the workspace overflowed horizontally by 20px on a 393px viewport (grid children lacked `min-width:0`).
