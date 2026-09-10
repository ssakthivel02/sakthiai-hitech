# GitHub Protection Required Before SakthiAI Release

Release-control status: **HOLD while canonical `main` is not server-side protected.**

A repository workflow named `Protected Main Gate` is not equivalent to GitHub branch protection. Before a production release or production-impacting integration is authorized, verify through GitHub that canonical `main` is protected by an active ruleset/branch protection with PR-only integration, required status checks, up-to-date branch requirement, deletion protection and force-push blocking.

Minimum required contexts after GOV-SAFE-001 is merged and has produced the checks:

- `protected-main-gate`
- `parallel-work-guard`

Other release/quality contexts remain required wherever the repository release process marks them applicable.

This file is a release HOLD condition, not evidence that protection has already been configured.
