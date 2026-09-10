# SakthiAI Parallel Work and Main-Branch Safety Policy

Status: mandatory for all human and AI contributors  
Canonical repository: `ssakthivel02/sakthiai-hitech`  
Integration branch: `main`

## Purpose

Prevent one agent, assistant, automation or human change from overwriting, bypassing or invalidating another concurrent task.

## Non-negotiable rules

1. Never develop directly on `main`; every implementation task uses a dedicated branch from the exact current `main`.
2. One task uses one branch. Do not create a duplicate branch when an existing usable task lane already exists.
3. Never force-push, rewrite history, reset or destructively move `main`.
4. Before any write, verify canonical repository, active branch and exact current main SHA and inventory open PRs/issues/relevant workflows.
5. Re-check current `main` immediately before merge. If it moved, deliberately reconcile drift and rerun applicable CI on the reconciled exact head.
6. Never treat skipped, cancelled, stale or different-head CI as merge evidence.
7. Never weaken or bypass required CI/protection merely to obtain a green result.
8. API/automated merges require an expected-head SHA guard.
9. High-risk overlap requires deliberate reconciliation: workflows, database schema/migrations, auth/RBAC/tenant isolation, retrieval/provenance, runtime/deployment contracts, secrets/environment contracts and lockfiles.
10. Secrets never enter branches, commits, PR bodies or issues. Runtime secrets belong only in approved secret stores.
11. DNS, production deployment, paid providers, destructive migrations, external-action executors and production credentials require separate explicit owner approval and evidence.
12. After merge, re-read `main`, record its exact SHA and re-verify protection before starting the next repository mutation.

## Required merge sequence

`verify current main -> inventory -> smallest evidence-backed change -> dedicated branch -> QA -> exact-head required checks -> re-read main -> reconcile drift if any -> expected-head guarded merge -> verify new main/protection`

## Parallel-agent coordination

Before starting a task, inspect open branches and pull requests. If another active branch overlaps the same high-risk files, do not blindly overwrite it. Preserve valid work from both sides and reconcile only the required concepts into current architecture.

## Emergency rule

If accidental direct work lands on `main`, do not rewrite history. Freeze conflicting edits, capture the exact SHA, reconcile through a fresh evidence-backed branch/PR, rerun CI and document the correction.

## Server-side protection requirement

Repository files and CI cannot prevent an authorized account from pushing directly to an unprotected branch. GitHub server-side rulesets/branch protection must therefore require PRs and the required checks, require branches to be up to date, and block force pushes and deletions. Until that is configured, repository governance is incomplete even when this policy and CI are green.
