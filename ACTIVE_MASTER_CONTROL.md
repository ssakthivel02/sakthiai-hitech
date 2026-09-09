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

## Branch policy

Task branches are allowed only for genuinely new, evidence-backed gaps. A task branch must start from the current `main`, remain narrowly scoped, pass applicable QA, and merge back to `main`.

Do not create a replacement or duplicate branch for already completed work.

## Duplicate-artifact policy

Do not create duplicate repositories, websites, previews, dashboards, folders or deployments for an already active scope. First locate and continue the existing HI-TECH source.

## Enforcement

`ACTIVE_MASTER_CONTROL.json` is the machine-readable contract. The repository `Protected Main Gate` validates the canonical repository, active branch target and core task-control rules for every pull request targeting `main`.

This governance contract does not replace the existing SakthiAI Quality Gate, runtime readiness checks, deployment approval or any feature-specific evidence gate.
