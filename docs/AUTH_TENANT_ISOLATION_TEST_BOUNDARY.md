# Auth/session + tenant-isolation negative-test boundary

This lane adds repository-level negative evidence for the existing SakthiAI HI-TECH authorization boundary without modifying the authorization implementation.

## Proven by the automated matrix

- anonymous callers cannot invoke protected workspace procedures;
- an authenticated user cannot list projects for a workspace that `getWorkspaceForUser` does not authorize;
- an authenticated user cannot list documents for a foreign workspace;
- conversation-history access to a foreign workspace is denied before database/message lookup;
- chat submission to a foreign workspace is denied before database access, retrieval, persistence, or LLM invocation;
- the rejection code is explicit (`UNAUTHORIZED` for no authenticated user, `FORBIDDEN` for a foreign workspace).

## Deliberately not claimed

This repository test is not a substitute for a live preview multi-user exercise. It does not prove:

- OIDC provider configuration or browser cookie behavior in the deployed preview;
- session expiration, revocation, logout propagation, CSRF posture, or concurrent-device behavior;
- database-level row-level security (the application currently enforces ownership in application logic);
- cross-tenant storage-provider isolation outside the tested request path;
- Creator-specific authorization on PR #7;
- production security certification or penetration-test completion.

A controlled preview must still exercise at least two real test identities against the exact deployed commit and record negative cross-tenant results before Gate A can be called complete.
