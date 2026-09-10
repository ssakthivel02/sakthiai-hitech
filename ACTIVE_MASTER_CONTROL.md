# SakthiAI HI-TECH — ACTIVE MASTER

## Canonical source

- Active repository: `ssakthivel02/sakthiai-hitech`
- Active integration branch: `main`
- Status: **HI-TECH — ACTIVE MASTER**

This repository is the only active development source of truth for SakthiAI in this workstream.

## OLD / LEGACY policy

OLD and LEGACY versions are read-only references only. They must not receive new development, fixes, redesign, deployment changes or content updates.

If a useful item exists only in OLD/LEGACY, reconcile it once into this HI-TECH master after verifying it is genuinely missing here. Do not upgrade the old project separately.

## Task start contract

Before any new task:

1. Confirm this repository and current `main` as the active master baseline.
2. Inventory completed work already present in the active master.
3. Select only a genuine gap supported by missing/failing evidence.
4. Build, test and record evidence for that single task before starting the next task.

Completed tasks must not be recreated merely because an older branch, preview or legacy project contains a different implementation.

## Strict GitHub safety policy

Before every repository write:

1. Re-read the canonical repository, active branch and exact current `main` SHA.
2. Inventory open pull requests, issues and relevant workflows so existing work is not duplicated.
3. Confirm the smallest evidence-backed change that closes the identified gap.
4. Create a dedicated task branch from the exact current `main`; normal development must not be written directly to `main`.

During implementation and integration:

- Never force-push, rewrite history, reset or destructively move protected `main`.
- Never weaken, remove or bypass required CI, protection or rulesets merely to obtain a green result.
- A skipped, cancelled, stale or different-head check is not merge evidence.
- Merge only after all applicable required checks pass on the exact pull-request head.
- API or automated merges must use an expected-head SHA guard so a moved PR head is rejected rather than silently merged.
- High-risk overlap in workflows, database schema/migrations, auth/RBAC/tenant isolation, runtime/deployment contracts, secrets/environment contracts or lockfiles requires deliberate reconciliation rather than blindly choosing one branch's version.

After every merge:

1. Re-read `main` and record the new exact SHA.
2. Re-verify that the canonical repository/branch and protection state remain correct.
3. Confirm the merged state before closing the task or starting another repository mutation.
4. Stop repository changes when the remaining blockers are genuinely manual, external, legal, safeguarding, organisational or explicit owner-attestation work.

## Branch policy

Task branches are allowed only for genuinely new, evidence-backed gaps. A task branch must start from the current `main`, remain narrowly scoped, pass applicable QA, and merge back to `main`.

Do not create a replacement or duplicate branch for already completed work.

## Duplicate-artifact policy

Do not create duplicate repositories, websites, previews, dashboards, folders or deployments for an already active scope. First locate and continue the existing HI-TECH source.

## Enforcement

`ACTIVE_MASTER_CONTROL.json` is the machine-readable contract. The repository `Protected Main Gate` validates the canonical repository, active branch target, core task-control rules and strict GitHub safety contract for every pull request targeting `main`.

Repository CI cannot by itself stop an authorized account from directly pushing to an unprotected branch. GitHub server-side branch protection/rulesets must also require pull requests and the required status checks, block force pushes/deletions, and require branches to be current before merge.

This governance contract does not replace the existing SakthiAI Quality Gate, runtime readiness checks, deployment approval or any feature-specific evidence gate.
