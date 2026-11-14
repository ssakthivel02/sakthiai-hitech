# SakthiAI Creator — admitted-but-crashed avatar recovery

Status: **release HOLD**. Scope: HeyGen v3 avatar generation under migration 0025. This is a read-only investigation protocol, **not** authorization to call the provider, release spend, or run a migration.

## Proven boundaries

- `creatorGenerations.status = SUBMISSION_UNKNOWN` is persisted by `beginProviderSubmission()` **before** the consent admission update and before the HTTP request.
- `creatorConsents.lastDispatchAdmittedAt` serializes with revocation but belongs to the consent, **not** to a generation. It can reflect a different job; it is not a dispatch receipt.
- Once migration 0026 is applied, `creatorAvatarDispatchAdmissions` records the **generation ID, callback ID, consent ID and admission time** in a transaction serialized with revocation. This is an admission receipt only: it does not prove HeyGen received, accepted or charged for the request. The per-generation record may be absent for older pre-0026 jobs.
- A missing `creatorProviderJobs` row or provider ID does **not** prove there was no charged request. The application can crash after provider acceptance and before local persistence.
- Existing idempotency keys are never resubmitted automatically. Treat the spend reservation as potentially consumed until independently reconciled.

## Read-only investigation

Using a **SELECT-only** account in the correct workspace, obtain the generation id, idempotency key, provider, model, state, timestamps and scoped provider-job row. Retrieve the matching spend-ledger hold status without changing it. Identify the exact consent id from immutable generation parameters, and inspect the consent record separately. For jobs admitted under migration 0026, inspect the generation-scoped admission receipt, matching generation/workspace/callback; treat no receipt as inconclusive for earlier versions and ambiguous pre-transaction crashes. Avoid exposing signed audio, credentials or private consent evidence in the report.

Record a timestamped evidence bundle: workspace/project/generation, consent id, idempotency key/callback id, current state, provider job id if any, hold state, owner, and SHA or checksum of any artifact. Never infer a generation's dispatch from the shared `lastDispatchAdmittedAt` value.

## Outcome classification

| Evidence | Safe operator action |
| --- | --- |
| Confirmed provider job ID + matching callback/idempotency and tenant scope | **Read-only poll / reconcile existing job**, subject to owner approval; never regenerate |
| Provider confirms **no submission/no billing** for the exact callback, with authoritative evidence | Escalate for a separately reviewed settlement decision; never automatically reuse the original idempotency key |
| No provider ID, provider lookup unavailable, or conflicting evidence | **UNKNOWN**: retain the hold, keep submission blocked, escalate to owner/provider |
| Provider accepted but local job row absent | Preserve provider proof and reconcile through an approved, transactional repair; do not submit again |
| Consent revoked before dispatch admission | Do not dispatch; verify the generation's failure and released hold, using scoped records |
| Consent admitted before revocation | Revocation cannot recall admitted work; do not assume the provider received it |

## Explicit prohibitions

No automatic retry, no new paid HeyGen request, no manual status flip, no hold release, no fabricated provider receipt, no production SQL mutation and no main-branch merge based solely on a passing regression suite.

## Before lifting the HOLD

Require authoritative provider acceptance/callback reconciliation and crash-injection tests (the migration 0026 admission receipt does not provide provider-acceptance proof) across **before admission**, **after admission/before HTTP**, **after remote acceptance/before job persistence**, and **after persistence/before spend settlement**. Include real MySQL and ledger inspection, tenant isolation, and owner approval for any actual billable smoke test.
