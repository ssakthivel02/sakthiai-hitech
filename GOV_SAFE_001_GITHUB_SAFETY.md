# GOV-SAFE-001 — Strict GitHub Safety

Status: repository-side control implemented on task branch; server-side protection remains a manual GitHub setting until verified.

## Evidence-backed gap

At task start, canonical `main` was `d6fa112f611e6cc17a24dc4787be244b9fd5d2c3`. GitHub reported `protected: false` and the repository rulesets endpoint returned an empty set. Repository CI existed, including `Protected Main Gate`, but repository files alone cannot prevent an authorized direct push to an unprotected `main`.

A historical draft PR contained useful parallel-work governance concepts but was based on stale main and also overlapped runtime/security code. This task reconciles only the governance concepts into current architecture; it does not merge the historical runtime diff.

## Repository-side controls

- `ACTIVE_MASTER_CONTROL.json` schema 1.1.0 machine-enforces strict GitHub safety policy markers.
- `ACTIVE_MASTER_CONTROL.md` defines before-write, integration and post-merge discipline.
- `.github/PARALLEL_WORK_POLICY.md` defines parallel-agent and drift controls.
- `.github/pull_request_template.md` requires exact-head/reconciliation evidence.
- `.github/CODEOWNERS` identifies high-risk ownership surfaces.
- existing `Protected Main Gate` validates the safety contract.
- `SakthiAI Parallel Work Guard` rejects stale-main candidates and secret-bearing committed paths and classifies high-risk overlap.

## Server-side acceptance criteria

GitHub `main` is not considered protected until a server-side ruleset/branch protection is verified as active with, at minimum:

1. target `main` / default branch;
2. require pull request before merge;
3. require status check `protected-main-gate`;
4. require status check `parallel-work-guard` after this task is merged and the check name has run successfully;
5. require branch to be up to date before merge;
6. block force pushes;
7. block branch deletion;
8. minimal/empty bypass list unless a documented operational exception is genuinely required.

A sole-owner repository may use zero required approving reviews if requiring self-approval would make the repository impossible to operate. That does not remove the PR, CI, up-to-date or force-push/deletion protections.

## Non-claims

A green repository workflow does not prove GitHub server-side protection is active. Protection must be re-read from GitHub after configuration. This task does not authorize production deployment, DNS changes, paid-provider activation, secret changes, database mutation or Creator production readiness.
