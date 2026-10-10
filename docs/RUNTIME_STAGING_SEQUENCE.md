# Post-CI preview staging sequence (PREPARED, NOT EXECUTED)

Status: **PREPARED EVIDENCE ONLY.** Nothing here has been run against Render, Aiven, DNS or any live secret. Every step below needs the owner's separate explicit authorization at execution time. Evidence for the migration step is `reports/staging/runtime-migration-manifest.json` (LOCAL_REHEARSAL on a throwaway local server; it is not a live-database claim).

Known facts at preparation time: Render service `sakthiai-hitech-preview` has autoDeploy OFF and runs `79fbe21d4289782ceba88c604fc0984a37d5632a`; Aiven `hitech-preview-mysql` is POWEROFF; approved preview database is `sakthiai_preview`. PR #29 stays DRAFT/UNMERGED; production is never touched.

**Precondition (hard gate):** exact-head GitHub CI is green for the SHA to be deployed (validate, mysql-integration on MySQL 8, e2e, release-evidence). Until then stop at step 1.

| # | Step | Command / action | Pass criterion | Abort / rollback |
|---|---|---|---|---|
| 1 | Freeze the exact SHA | Record `git rev-parse HEAD` of the PR #29 head after CI; note CI run IDs; no further pushes | One 40-hex SHA written down; CI green on that SHA | Any CI red: stop |
| 2 | Capture the Aiven recovery point | In the Aiven console take/confirm a backup (PITR or manual) of the preview service; record its id/time | Backup id recorded BEFORE any change | No recovery point: stop |
| 3 | Power on the existing DB only | Power on `hitech-preview-mysql`; do not create a new service | Service state RUNNING; same service id | Do not create replacement infra |
| 4 | Verify DB and TLS | `mysql --ssl-mode=VERIFY_CA ... -e "SELECT VERSION(), @@have_ssl"` to `sakthiai_preview`; confirm engine is MySQL 8 | Version 8.x, TLS verified, db name exactly `sakthiai_preview` | Wrong db/engine/TLS: stop |
| 5 | Apply migrations | First `SELECT COUNT(*) FROM __drizzle_migrations` must equal 5 (baseline 0000-0004). Then `pnpm db:push` (= `drizzle-kit migrate`, same journal mechanism the manifest verified) with the frozen SHA's `drizzle/` | Count = 11; tables from 0005-0010 exist; no destructive statements (manifest shows 0) | Forward-only: failure => restore the step-2 recovery point; never hand-edit |
| 6 | Run the backfill | `pnpm db:backfill-search-text` (idempotent; fills NULL and upgrades pre-0019 rows) | `BACKFILL_DONE`; rerun prints `updated=0`; `SELECT COUNT(*) FROM documentChunks WHERE searchText IS NULL OR searchText NOT LIKE '%~tl~%'` = 0 | Re-run is safe; persistent failure => stop, retrieval still works lexically |
| 7 | Set MySQL-backed provider state | Set `GATEWAY_STATE_STORE=mysql`; keep `GATEWAY_ALLOW_EXTERNAL` unset/false; no provider API keys | `/readyz` shows gateway state store mysql; no external provider configured | Unset the variable (in-memory fallback) |
| 8 | Deploy the exact SHA to the EXISTING Render service | Render: manual deploy of the frozen commit to `sakthiai-hitech-preview` only; autoDeploy stays OFF | Deploy `live` for that commit | Re-deploy previous commit `79fbe21...` |
| 9 | Verify /releasez | `curl https://<preview-host>/releasez` | Reported commit equals the frozen SHA | Mismatch: roll back deploy |
| 10 | Verify /healthz | `curl .../healthz` | `{"status":"alive"}` | Roll back deploy |
| 11 | Verify /readyz | `curl .../readyz` | 200 `ready`; `dependencies.taskWorker.state` = `disabled`, `uploadCleanup.state` = `disabled`; scanner `fileIngestion: coming_soon` | 503/unexpected: inspect, do not enable features |
| 12 | Two-tenant / replay / revoke / budget / circuit acceptance | Run the preview acceptance script against two real test users: tenant isolation, OAuth replay refusal, session revoke, budget denial, circuit breaker | All checks pass with evidence saved | Any failure: stop, record, roll back if data was affected |
| 13 | Real IdP / storage acceptance | Real OIDC login round trip and one object-storage put/get through the authorised proxy | Login works; foreign storage key denied | Stop; do not enable uploads |
| 14 | Run real ClamAV before enabling ingestion | Stand up a real ClamAV/clamd; run clean, EICAR and clamd-down cases through finalize | clean => stored; EICAR => REJECTED + purged; unavailable => 503 and bytes stay quarantined | Keep `FILE_INGESTION_BACKEND_ENABLED` unset |
| 15 | Keep paid/external providers disabled | Confirm no `LLM_API_KEY`/external base URL, `GATEWAY_ALLOW_EXTERNAL` false | `/readyz` and gateway status show no external provider | Remove any key that appears |

## Feature flags introduced by 0016-0018 (all default OFF; enable one at a time AFTER step 15, each with its own acceptance)
- `TASK_WORKER_ENABLED=true` (+ `TASK_WORKER_CONCURRENCY`, `_POLL_MS`, `_LEASE_MS`, `_SHUTDOWN_GRACE_MS`): enables the in-process worker and `chat.sendAsync`.
- `MCP_CHAT_TOOLS_ENABLED=true` (+ `MCP_ALLOWED_ENDPOINTS`): offers approved read-only MCP tools to the durable chat path. Requires the worker.
- `UPLOAD_CLEANUP_ENABLED=true` (+ `UPLOAD_CLEANUP_*`): scheduled quarantine cleanup. Does not enable uploads.
- `FILE_INGESTION_BACKEND_ENABLED=true`: only after step 14.

## Gotchas
- 0006 ALTERs `documentChunks` (adds `searchText` and indexes): on a large table this can take locks; the preview DB is small, but check row count first.
- The retrieval upgrade is two-phase: migrations first, backfill second. Between them retrieval still works (legacy rows are scanned in a bounded set); cross-script (Tamil<->Tanglish) matching starts only after the backfill.
- The migration manifest was verified on MariaDB 10.11 (local). MySQL 8 behaviour is covered only by the CI `mysql-integration` job once it runs.
- Rollback of schema is restore-only (forward-only migrations). The step-2 recovery point is the only rollback for step 5.
