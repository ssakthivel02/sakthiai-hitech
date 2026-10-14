# Release evidence manifest

Status: **SOURCE_IMPLEMENTED / LOCALLY_TESTED / CI_PENDING**. The workflow changes below have not run on GitHub yet.

`pnpm release:evidence [--require-pass] [--require-ci]` writes `reports/release/release-evidence.json` for the exact checked-out commit.

## Gates (each is PASS / FAIL / MISSING / ATTESTED / NOT_ATTESTED, never inferred)
frozen install and typecheck (attested only by upstream CI job success), unit tests, MySQL integration, E2E, contract evals, golden benchmark, recovery rehearsal, capability-map validation, migration consistency (journal/SQL/schema, forward-only), secret hygiene, source neutrality (source and dist), production advisories (0 critical / 0 high), build, built-server smoke, and CI-SHA binding.

## Claims block
`SOURCE_IMPLEMENTED` true; `LOCALLY_TESTED` only when every local gate passes; `CI_VERIFIED` only inside GitHub Actions with all three upstream jobs attested, a clean tree, a matching SHA and no failed/missing gate; **`RUNTIME_VERIFIED` is always false** (nothing here observes a deployed runtime, a real scanner, a real model or production). Overall values: `GATES_FAILED`, `GATES_INCOMPLETE`, `LOCAL_GATES_PASS_CI_PENDING`, `CI_GATES_PASS`.

## Workflow (`.github/workflows/quality-gate.yml`, no new overlapping workflows)
`validate` gains secret hygiene, a production advisory gate, JSON test report, scripted neutrality and smoke guards and uploads `validate-evidence`; `mysql-integration` also uploads the recovery report; new job `release-evidence` (needs validate, mysql-integration, e2e) downloads the reports, builds, and runs `pnpm release:evidence --require-pass --require-ci`, uploading `release-evidence`.

## Local use
After the individual gates have produced their reports: `pnpm release:smoke` (needs `pnpm build`), `pnpm audit --prod --json > reports/audit/audit-prod.json`, then `pnpm release:evidence`. A local run tops out at `LOCAL_GATES_PASS_CI_PENDING`.
