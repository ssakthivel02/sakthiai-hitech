# Value Ledger (v1)

One administrator view of what SakthiAI did and what it cost, per UTC day. It answers the question an operator needs for a private beta: how many answers did we produce, and what did the model and Creator spend come to?

## Interface

`ops.valueLedger({ from: "YYYY-MM-DD", to: "YYYY-MM-DD" })` is a tRPC query. It is restricted to users with role `admin`, covers an inclusive range of at most 31 days, and is read-only. Non-admin callers get `FORBIDDEN`. Without a database the response is `PRECONDITION_FAILED VALUE_LEDGER_DATABASE_UNAVAILABLE`, never partial data.

## Sources (existing tables; no migration)

| Section | Source | Meaning |
|---|---|---|
| `model` | `providerUsageWindows` | Actual requests, tokens and cost after commit, summed over workspaces. `estimatedCommits` counts calls whose usage the provider did not report |
| `model.providers` | `providerUsageHolds` | Per provider: committed, released (failed, refused after reservation or cancelled) and still-held calls, plus the released share |
| `creator` | `creatorSpendWindows` (scope `global`), `creatorSpendHolds` | Paid generations and cost per day; per model, outcome counts and committed cost |
| `activity` | `messages`, `conversations`, `documents`, `projects` | Rows created per UTC day. Days are bucketed by epoch, so the session time zone does not move them |
| `daily` | all of the above | One row per day, zero-filled |

`model.costPerAssistantMessage` is model cost divided by assistant messages in the range, given only when model usage is persisted and a cost unit is configured.

## Truthfulness rules

- Model usage is in the database only with `GATEWAY_STATE_STORE=mysql`. Otherwise `model.usageRecording` is `not_persisted` and every model figure is `null`: the ledger does not report zeros that look like "no usage".
- Model cost (`GATEWAY_COST_UNIT`) and Creator cost are configured separately and are never added together.
- `quality.status` is `NOT_MEASURED`. No per-answer feedback or grading exists, so the ledger makes no quality claim. Model quality evidence comes from the separate Q8 evaluation.
- The response contains aggregates only: no prompts, message text, file names, user identities or provider payloads.

## Tests

`server/ops/valueLedger.test.ts` covers the range rules, admin-only access and fail-closed behaviour without a database. `server/ops/valueLedger.mysql.test.ts` runs on real MySQL: it checks aggregation inside the range only, provider and model outcomes, the not-persisted case, independence from the session time zone (`+05:30`), zero-filled days, and that seeded file names and message text never appear in the output.

## Not included

There is no UI (the endpoint is the interface), no per-workspace billing view and no retention policy for the underlying counters. Activity counts scan the date range without a dedicated index, which is acceptable at private-beta scale.
