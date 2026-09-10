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
