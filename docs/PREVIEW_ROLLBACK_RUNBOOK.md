# SakthiAI HI-TECH Preview Rollback Runbook

## Scope

This runbook covers the `sakthiai-hitech` **preview** environment only. It does not authorize production deployment, DNS changes, paid-provider activation, destructive database actions, or bypassing GitHub protection.

## Rollback trigger

Use rollback only after a deployed preview release is shown to be defective and the operator has identified a previously known-good exact commit. Do not roll back to a branch name, `latest`, or an unverified artifact.

## Mandatory evidence before rollback

1. Record the currently deployed exact commit from `/releasez`.
2. Record the proposed previous known-good 40-character commit SHA.
3. Confirm the proposed target previously passed the repository's required CI/release gates.
4. Preserve immutable build/release evidence for both current and rollback targets where available.
5. Determine whether database migrations occurred between the two commits.
6. If any migration is destructive or backward-incompatible, obtain verified backup/restore evidence and a tested restore plan before changing application code.
7. Obtain explicit operator approval for the rollback action.

## Security-qualified targets and containment (24 Oct 2026)

- **Security baseline.** Every rollback target must contain `403c8f8a2db6fa532a80ae659668fbd18bf779b2`, the first commit with all of these: the local-provider classification and redirect refusal, the Creator redirect refusal, and the high-advisory dependency fixes (`release/rollback-contract.json` → `securityBaseline`).
- **Forbidden target.** `469c668e71ceaae800e8605c5814e7017035fdbc` is the build the preview serves today, and it lacks those fixes. It is never a rollback target.
- **Contain when nothing qualifies.** Until a build at or after the baseline has served this environment and passed acceptance, there is no previously verified good target. Do not fall back to an older build. Suspend the service (Render → service → Settings → Suspend) or enable maintenance mode (Render → service → Settings → Maintenance Mode). CI-verified baseline builds (`403c8f8`, `95fbcc3`, `2eb2b6e`) can be redeployed only with the full post-rollback acceptance below, and are recorded as `ci-verified-only`.
- **Application rollback is not a database restore.** Migrations are forward-only and additive after 0004, so an older build at or after the baseline runs against a newer schema it does not use (extra tables are ignored, and `/readyz` checks only declared tables). An application rollback therefore needs no restore when every migration applied after the target's journal is additive. A database restore is a separate, approved action (`docs/RECOVERY_REHEARSAL.md`): it restores the attested recovery point and loses later writes. Never restore a database just to roll back application code.
- **Check the target first.**
  `node scripts/check-rollback-target.mjs <target-sha> reports/staging/preview-migration-post.json`
  Use the latest live-journal report from the guarded workflow. The output is `rollback-to-target` or `contain` with its reasons. It checks the forbidden list, the baseline ancestry, that the target's migrations are identical to the candidate's prefix, that the target's migrations are already applied live, and that everything applied after them is additive.

## Execution boundary

The controlled strategy is **redeploy the previous known-good exact commit**. This repository does not authorize an automatic production rollback. Never force-push `main`, rewrite history, delete commits, guess a database schema state, or silently revert unrelated work.

## Post-rollback acceptance

The rollback is not successful merely because the deployment process completes. Verify all of the following against the deployed preview:

- `/healthz` returns the expected healthy response.
- `/readyz` returns ready; a degraded dependency state is a rollback failure requiring investigation.
- `/releasez` reports the exact intended rollback commit, not `unknown` or another SHA.
- Authentication, database, storage and core application smoke paths remain functional.
- If database restoration was required, verify restored data and migration state separately.
- Record the operator, source commit, rollback commit, reason, timestamps, health/readiness/release evidence, and any follow-up remediation.

## Fail-closed rules

Stop rather than proceed when any of these are unknown: rollback commit SHA, release identity, CI status, migration compatibility, backup evidence for an incompatible schema change, or operator approval.

A green contract-validation workflow proves only that the rollback controls are encoded consistently. It does **not** prove a live rollback has been executed successfully. Live rollback evidence must come from an approved runtime drill or actual incident response.
