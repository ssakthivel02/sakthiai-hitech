# SakthiAI Safe Merge Checklist

Use immediately before every merge to `main`.

- [ ] Re-read `ssakthivel02/sakthiai-hitech` `main` and record exact SHA.
- [ ] Re-read the PR and record exact head SHA.
- [ ] Confirm no newly opened overlapping high-risk PR invalidates the reconciliation.
- [ ] Confirm the candidate contains current `main`; if not, reconcile and rerun CI.
- [ ] Confirm every applicable required check is successful on the exact PR head.
- [ ] Confirm no required check was skipped, cancelled, stale or taken from another SHA.
- [ ] Confirm no CI/protection/ruleset was weakened to obtain green.
- [ ] Confirm no secret-bearing file or credential was committed.
- [ ] For API/automated merge, pass the exact PR head as the expected-head SHA guard.
- [ ] After merge, re-read `main`, record the new exact SHA and verify GitHub server-side protection/ruleset state.

If any item fails, do not merge.
