# Controlled Beta Capability Truth Boundary

This repository distinguishes **research lifecycle**, **repository implementation**, and **user-facing availability**.

A research record marked complete does not mean a feature is available to users. A feature implemented in source does not become `Available` merely because CI is green. The canonical machine-readable boundary is `release/beta-capability-contract.json`.

## Public states

- `Available`: allowed only when repository evidence exists, exact deployed runtime evidence exists, and explicit owner approval is recorded outside this contract.
- `Preview`: source-level implementation/evidence exists, but controlled runtime/browser acceptance remains incomplete.
- `Coming Soon`: not part of the currently proven canonical runtime or still blocked by implementation/runtime/provider/human acceptance.

## Fail-closed rule

`scripts/validate-beta-capability-contract.mjs` rejects any `Available` claim unless `runtimeEvidence=true`, `ownerApproved=true`, and repository evidence is non-empty. CI also verifies that a deliberately unsafe fixture fails validation.

## Current evidence boundary

The contract does not prove deployed preview health, OIDC/session behavior, provider credentials, paid generation, live storage/database behavior, human Creator review, production approval, or DNS promotion. Those remain separate runtime/owner gates.
