# GOV-SAFE-001 — GitHub Ruleset Setup

This is the one remaining manual step after repository-side GOV-SAFE-001 is merged and its checks have run successfully.

In GitHub repository Settings → Rules → Rulesets, create or edit one branch ruleset for the default branch / `main`:

- Enforcement: **Active**
- Target: default branch / `main`
- Restrict deletions: **On**
- Block force pushes / non-fast-forward updates: **On**
- Require a pull request before merging: **On**
- Required approving reviews: **0** for the current sole-owner operating model unless another eligible reviewer is intentionally added
- Require status checks to pass: **On**
- Require branches to be up to date before merging / strict checks: **On**
- Required check: `protected-main-gate`
- Required check: `parallel-work-guard` (add only after this check has run at least once and GitHub offers it in the selector)
- Bypass list: **empty/minimal**; add nothing unless a documented operational requirement genuinely exists

After saving, verify through GitHub API/UI that `main` reports protected and the ruleset is active. Do not change `release/GOV_SAFE_001_STATUS.json` to verified merely because this document exists.

If GitHub does not yet offer `parallel-work-guard` in the required-check selector, merge the repository-side governance only after its exact-head CI passes, let the check run on `main`/a subsequent PR as applicable, then return to the ruleset and add it. `protected-main-gate` should be required immediately if already available.
