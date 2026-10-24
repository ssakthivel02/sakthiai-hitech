# Authenticated request limits

Every authenticated tRPC procedure passes `enforceAuthenticatedRateLimit` (`server/_core/trpc.ts`). Policies (per user, fixed window) are in `server/_core/rateLimit.ts`: default 180/min, `chat.send` 20/min, `files.upload` 12/min, Creator submit 3/min, Creator job operations 30/min. Pre-authentication sign-in starts use a separate per-process limiter (`server/_core/oauth.ts`), unchanged.

## Stores
| `RATE_LIMIT_STORE` | Behaviour | When |
|---|---|---|
| unset / `memory` (default) | Per-process counters. N instances admit up to N x the policy. | One instance (the current preview runs one) |
| `mysql` | One counter per (policy, user) in `rateLimitWindows`, shared by every instance. Upsert and read of the same row in one transaction; InnoDB row locking admits exactly `maxRequests` per window fleet-wide. Windows are aligned to `windowMs`; an instance whose clock is behind cannot reset a newer window. Expired rows are pruned (500 rows per minute per process). | Before running more than one instance |

Unknown values, or `mysql` without `DATABASE_URL`, fall back to `memory` with a startup warning.

## Failure policy
This is an abuse guard, not a spend control. Spend is enforced by the gateway budget and the Creator ledger, and those fail closed. If the shared store errors (database down, table missing), the request is decided by the per-process limiter, so an outage degrades to per-instance limits rather than locking every user out. Fallbacks are counted (`status()`) and logged at most once a minute.

## Adoption (owner-gated)
The table is a proposal: `drizzle/proposals/rate_limit_windows.sql`. It is not in the migration journal, not applied by `pnpm db:push` and not in `drizzle/schema.ts`. So `/readyz` and the 0011/0012 migration review are unchanged. To adopt: approve it, move it into `drizzle/` with the next journal number, add it to `schema.ts`, migrate, then set `RATE_LIMIT_STORE=mysql`. Rollback: unset the variable (immediate). Afterwards, optionally `DROP TABLE rateLimitWindows`.

## Evidence
`server/_core/sharedRateLimit.test.ts` (selection, fallback, validation) and `server/_core/sharedRateLimit.mysql.test.ts` (real MySQL: 3 instances x 30 concurrent requests, exactly 5 admitted; per-user/per-policy isolation; window rollover; clock skew; pruning). Both are mutation-checked. No live multi-instance run exists.
