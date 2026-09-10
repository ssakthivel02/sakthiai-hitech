# GOV-SAFE-001 Scope

Included:
- repository-side strict GitHub safety contract;
- current-main ancestry/parallel-work guard;
- exact-head/expected-head merge discipline;
- high-risk CODEOWNERS and PR checklist;
- release HOLD while server-side protection is unverified;
- deterministic tests and QA;
- ruleset setup and post-merge verification instructions.

Excluded:
- runtime feature changes;
- tenant-isolation changes already merged through PR #8;
- Creator implementation from PR #7;
- database migrations;
- DNS/deployment/provider activation;
- secrets;
- paid services;
- production cutover.

Historical PR #2 is a read-only one-time reconciliation donor for governance concepts only and must not be merged wholesale into current main.
