# Authenticated request limits

Every authenticated tRPC procedure passes `enforceAuthenticatedRateLimit` (`server/_core/trpc.ts`). The policies are in `server/_core/rateLimit.ts`. Each is per user, with a fixed window:

| Policy | Limit | On shared-store failure |
|---|---|---|
| `authenticated-default` | 180/min | `scaled-local` |
| `chat-send` (model calls) | 20/min | `deny` |
| `file-upload` | 12/min | `deny` |
| `creator-submit` | 3/min | `deny` |
| `creator-provider-job` | 30/min | `deny` |

Pre-authentication sign-in starts use a separate per-process limiter (`server/_core/oauth.ts`), which is unchanged.

## Stores
| `RATE_LIMIT_STORE` | Behaviour | Use when |
|---|---|---|
| unset / `memory` (default) | Per-process counters. N instances admit up to N × the policy. Decisions are labelled `X-RateLimit-Scope: local`. | Exactly one instance (the preview runs one) |
| `mysql` | One counter per (policy, user) in `rateLimitWindows` (migration 0013), shared by every instance. Each request upserts and reads the same row in one transaction, so InnoDB row locking admits exactly the limit per window across the fleet. Windows align to `windowMs`. An instance whose clock is behind cannot reset or reuse a newer window. Expired rows are pruned (500 rows per minute per process). Labelled `global`. | Before running more than one instance |

Unknown values, or `mysql` without `DATABASE_URL`, fall back to `memory` with a startup warning.

## Failure policy (explicit; `RATE_LIMIT_STORE=mysql` only)
The shared store "cannot count" when the database is unavailable, an attempt exceeds `RATE_LIMIT_DB_TIMEOUT_MS` (default 1000 ms), the table is missing or has the wrong shape, or the breaker is open. A deadlock or lock-wait timeout is retried once first. In that case:
- **`deny` routes refuse.** The response is HTTP 503 `SERVICE_UNAVAILABLE` with `Retry-After` and `X-RateLimit-Scope: unavailable`. That is a statement that the counter is unavailable, not a quota verdict. These routes call models, accept uploads or start provider jobs, so they never run uncounted.
- **`scaled-local` routes** use a per-process window of `floor(limit / RATE_LIMIT_MAX_INSTANCES)` (default 2, range 1–64), labelled `local-degraded`. The fleet-wide bound still holds as long as at most that many instances run. Set the variable to the real instance ceiling.
- **Bounded failures.** After 3 consecutive failures the store is not called for 15 s (breaker open). The next request then probes it, and on success counting returns to `global`.
- **No silent substitution.** A per-process counter is never labelled `global`.
- **Availability is separate from spend.** This limiter only controls request admission. Paid model use is authorised by the gateway budget and paid Creator jobs by the spend ledger, and both fail closed independently.

## Operator status and readiness
`/readyz` publishes `dependencies.rateLimit = { store, state }`. States:
- `local`: memory store.
- `unchecked`: before the first check.
- `shared`: counting globally.
- `degraded`: recent failures or breaker open.
- `missing` / `incompatible`: table absent, or a required column type, length or primary key is wrong.

With `store: mysql`, `missing` and `incompatible` make `/readyz` return 503, because that is a deployment error. A transient outage does not, because the database probe already reports it. Every readiness call re-checks the table shape, rate-limited to once a minute after it has been confirmed. Failure logs carry only the failure class: no SQL, hostnames or driver text.

## Installing, upgrading and checking the table (governed)
- **Install.** The table is migration `drizzle/0013_rate_limit_windows.sql` (additive: one table and one index, no foreign keys, no user content; the key is `<policy>:user:<id>`). It is applied only by the guarded `preview-db-setup.yml` migrate run, from the candidate ref, with the migrate principal, after the inspect report is reviewed. The application never creates or alters it.
- **Check before migrate.** The inspect report lists `0013_rate_limit_windows` under `pendingTags`. The guard verifies the journal hashes and classifies the live schema against the journal.
- **Check after migrate.** The post and rerun no-op guards run. `/readyz` then shows `databaseSchema.status: current` and, if the variable is set, `rateLimit.state: shared` after the first request.
- **Adopt.** Set `RATE_LIMIT_STORE=mysql` and `RATE_LIMIT_MAX_INSTANCES` to the real instance ceiling, then restart.
- **Roll back.** Unset `RATE_LIMIT_STORE` (immediate; the table can stay). Dropping the table is optional and loses at most one window of counts. If the table were dropped while the variable is still `mysql`, `/readyz` returns 503 and costly routes refuse, which is fail-closed by design.
- **Upgrade.** Any future change to this table is a new journal migration. Applied migrations are never edited or renumbered.

## Evidence
- `server/_core/sharedRateLimit.test.ts`: store selection; per-policy failure behaviour for five failure kinds; deadlock retry; timeout, breaker and recovery; readiness; table-shape check.
- `server/_core/rateLimitMiddleware.test.ts`: 429 for an exhausted quota versus 503 for an unavailable counter; scope header.
- `server/_core/sharedRateLimit.mysql.test.ts`: independent pools on real MySQL, run by CI on MySQL 8.0 and 8.4 containers. Covers 120 concurrent requests across two policies with exact admission; 120 requests on one row through 2-connection pools; window boundary; backward clock; missing table with recovery; incompatible shape; outage with breaker and recovery; pruning.
- Mutation checks: counter reset (6 tests fail), backwards window (1), deny policy ignored (9), breaker off (2), shape check off (5).
- No live multi-instance run exists.

## Private-beta profile
The beta runs `RATE_LIMIT_STORE=mysql` with `RATE_LIMIT_MAX_INSTANCES=1`, which makes chat-send, file-upload and Creator routes refuse (503, `limits_unavailable` in the UI) rather than run uncounted. `config/beta/beta-production.env.example` and `node scripts/check-beta-profile.mjs --env-file <file>` check this setting together with the other beta posture settings before they are applied. Installing the table (`0013_rate_limit_windows`) remains a guarded, approval-gated migration; until it is applied, do **not** set `RATE_LIMIT_STORE=mysql` (`/readyz` returns 503 for a missing table, by design).
