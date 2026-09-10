# GOV-SAFE-001 Changelog

Baseline: `main` `d6fa112f611e6cc17a24dc4787be244b9fd5d2c3`.

Reconciled from historical governance donor PR #2 without importing its stale runtime/security diff:
- parallel-work/main safety policy;
- high-risk ownership concept;
- PR coordination checklist;
- stale-main ancestry guard;
- committed secret-path guard.

Strengthened for current SakthiAI architecture:
- machine-readable GitHub safety contract in ACTIVE MASTER;
- exact-head required-check policy;
- expected-head guarded API merge policy;
- post-merge main/protection re-verification;
- deterministic contract tests;
- explicit release HOLD until server-side protection is verified;
- exact ruleset setup and post-merge verification procedure.
