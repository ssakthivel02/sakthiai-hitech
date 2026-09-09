# SakthiAI Parallel Work and Main-Branch Safety Policy

Status: mandatory for all human and AI contributors
Canonical repository: `ssakthivel02/sakthiai-hitech`
Protected integration branch: `main`

## Purpose

Prevent one agent, assistant, automation, or human change from overwriting, bypassing, or invalidating another concurrent task.

## Non-negotiable rules

1. **Never develop directly on `main`.** Every implementation task uses a dedicated branch.
2. **One task = one branch.** Recommended names: `feature/<scope>`, `fix/<scope>`, `hardening/<scope>`, `release/<scope>`.
3. **No force-push to `main`.** No history rewrite, reset, or direct ref movement of `main`.
4. **No automatic merge.** A pull request must remain unmerged until current `main` is re-read and conflict/drift checks pass.
5. **Re-check latest `main` immediately before merge.** If `main` moved after the task branch was created, compare/reconcile first and rerun required CI on the reconciled head.
6. **Do not reuse another active agent's branch.** Parallel agents must use separate branches even when working on the same feature area.
7. **High-risk files require deliberate reconciliation.** This includes `.github/workflows/**`, `drizzle/**`, `server/**` auth/security/runtime code, `release/**`, deployment manifests, environment contracts, database migration/config files, and lockfiles.
8. **Canonical-source check is mandatory.** Work for the current SakthiAI Hi-Tech product must target only `ssakthivel02/sakthiai-hitech`. Older `ssakthivel02/sakthiai` and `saravanai-legacy` repositories are not launch sources.
9. **Secrets never enter branches, commits, PR bodies, issues, or chat.** Runtime secrets belong only in approved provider secret stores/dashboards.
10. **Production-impacting changes stay gated.** DNS, production deployment, paid providers, destructive migrations, external-action executors, and production credentials require explicit owner approval and separate evidence.

## Required merge sequence

`latest main` -> compare task branch -> reconcile drift -> exact-head CI -> review high-risk changes -> merge -> verify post-merge CI.

A green run from an earlier SHA does not authorize merging a newer SHA.

## Parallel-agent coordination

Before starting a task, inspect open branches and open pull requests. If another active branch overlaps the same high-risk files, do not edit those files until the overlap is understood. Prefer a non-overlapping workstream or record the dependency in the Launch Control issue.

When two branches overlap, preserve both sets of valid work. Never resolve by blindly taking "ours" or "theirs" across the whole file.

## Emergency rule

If accidental direct work lands on `main`, do not rewrite history. Freeze further conflicting edits, capture the exact SHA, compare affected branches against that SHA, reconcile through a new branch/PR, rerun CI, and document the correction.
