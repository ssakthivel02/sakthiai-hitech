# GOV-SAFE-001 Acceptance Gates

## Gate A — repository contract
- ACTIVE MASTER schema 1.1.0 valid.
- all strict GitHub safety markers true.
- parallel-work policy and safe-merge checklist present.

## Gate B — deterministic QA
- `github-safety-contract` successful on exact PR head.
- `parallel-work-guard` successful on exact PR head.
- `protected-main-gate` successful on exact PR head.
- SakthiAI Quality Gate successful on exact PR head.

## Gate C — integration safety
- re-read current `main` immediately before merge.
- if main moved, reconcile and rerun Gate B.
- merge using exact expected-head SHA guard.
- re-read new main after merge.

## Gate D — server-side protection
- active GitHub ruleset/branch protection verified for `main`.
- PR required.
- strict required checks configured.
- force pushes and deletions blocked.
- bypass empty/minimal.

Gate D cannot be satisfied by repository files alone. Until Gate D is real, production-impacting release remains HOLD.
