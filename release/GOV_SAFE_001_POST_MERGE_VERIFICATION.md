# GOV-SAFE-001 — Post-Merge Verification

Do not close GOV-SAFE-001 until all applicable items are evidenced.

1. Record the merged `main` SHA.
2. Confirm the merge commit exists on canonical `ssakthivel02/sakthiai-hitech` `main`.
3. Confirm exact-head PR checks were successful before merge.
4. Confirm post-merge quality/protected-main workflows are successful where triggered.
5. Configure the GitHub server-side ruleset using `GOV_SAFE_001_RULESET_SETUP.md`.
6. Re-read the GitHub `main` branch and rulesets endpoint.
7. Confirm `main` is protected and the ruleset is active.
8. Confirm required check `protected-main-gate` is present; add `parallel-work-guard` once GitHub exposes that successful check for selection.
9. Confirm force pushes and deletions are blocked and bypass is empty/minimal.
10. Only then may the machine-readable protection status be changed in a later evidence-backed PR.

Repository-side governance completion and server-side protection completion are separate facts. Never collapse them into one claim.
