# GOV-SAFE-001 Evidence Boundary

Repository evidence can prove that governance files, tests and workflows exist and that specific CI ran on a specific SHA.

Repository evidence cannot prove that GitHub server-side branch protection/rulesets are active. That requires a fresh GitHub API/UI read after configuration.

Therefore:
- `Protected Main Gate` workflow PASS != protected branch.
- policy text != enforced server-side rule.
- CODEOWNERS file != required review enforcement.
- exact-head CI PASS != production authorization.
- merge commit != production deployment.

All claims must preserve these distinctions.
