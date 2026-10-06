# SAKTHIAI FINAL RELEASE READINESS

**Decision: HOLD.** This is a preview-scope release.

The CI-qualified candidate is now **deployed to the existing preview**, and its deployed provenance, unauthenticated security boundary and landing accessibility are **runtime-verified**.

Core runtime acceptance is still **not verified**: real login, session revocation, two-tenant isolation, retrieval, grounding and the real model.
- The preview database is reachable, but **its schema is not migrated**. Since `77de9f7`, live `/readyz` shows that the connected `sakthiai_preview` exposes **0 of the 31 tables** this build needs.
- The repo secrets the guarded migration needs are missing.
- OIDC, LLM and storage are unconfigured.

Only owner actions can clear these.

Updated 5 October 2026, 01:45 UTC (sessions 23:35–23:53, 00:03–00:18, 01:06–01:17 and 01:20–01:45 UTC). Scope: `ssakthivel02/sakthiai-hitech`, PR #29 combined candidate, release to the existing **preview** only. Production, merging to `main` and paid providers are out of scope.

This file supersedes earlier versions: `bdb11a1` on this branch, and the copy inside `sakthiai-release-qualification-evidence.zip`.

## Dashboard

| State | Item |
|---|---|
| COMPLETED | Reconciliation (no other writer; source and preview state matched the record). Controlled preview deploys of CI-qualified `7b240f7`, then `2ea4b4f`; `/releasez` provenance verified for both. Live unauthenticated security probes. Live axe/mobile landing scan. Demonstrated landing-page defects fixed with a regression test. Existing preview-DB migration workflow given recovery-point, journal, preservation, rerun and backfill guards, rehearsed on MySQL 8. **Session 3:** three demonstrated guard gaps fixed in `ca6c369` (invalid dates accepted; migration hashes unchecked; rerun not compared to a snapshot), with 30 new regression tests including 6 on real MySQL |
| COMPLETED (session 4) | **Reproduced and fixed a readiness defect** (`77de9f7`): `/readyz` claimed `ready` against a database stuck at 0004. Exact-head CI `37252140753` PASS; deployed to preview `dep-db1g0449v7es73fctep0`; `/releasez` verified. This gives the first **read-only, secret-free evidence of the live DB schema**: 0/31 tables visible. The guarded migration sequence was proven locally on an **empty** MySQL 8 DB (`pre` applied=0/11 → `post` 11/11 → rerun no-op). The four-day schedule was added to the existing plan |
| IN PROGRESS | None. Changes frozen at `77de9f7`; see Final state |
| BLOCKED | **Preview DB migration: the GitHub repo secrets are missing.** Aiven `hitech-preview-mysql` is RUNNING on `free-1-1gb` (owner-checked in the console), with a provider-listed backup at `2026-10-05T00:28:42.354867Z` (after the 00:25 power-on; a restore of it has **not** been tested). The app connects (verified TLS, `SELECT 1`), but **from `77de9f7` `/readyz` reports `database: "schema_mismatch"` with 31/31 tables missing**. The DB is either empty, or its tables are invisible to the app user; the Day 1 inspect run will tell which. The guarded workflow, dispatched in read-only `mode=inspect` with that exact timestamp (run `37250477782`, job `111576895733`, checked-out SHA `a9be03b`), **stopped at its first check**: `SAKTHIAI_PREVIEW_DATABASE_URL is not configured`. Both secret values resolved empty (GitHub masks present secrets as `***`). No guard step ran and **no database access occurred**. `migrate` was not dispatched. OIDC, LLM and storage also still need secure owner entry |
| PENDING | Preview DB inspect + migration 0005–0010 + backfill (blocked on secrets); live login/logout/revocation/replay; two-user isolation; storage ownership; retrieval, citations and grounding; Tamil/Tanglish; MODEL_UNAVAILABLE live; worker, uploads and MCP. See `SAKTHIAI_20_DAY_CONTINUATION_PLAN.md` |
| OWNER ACTION REQUIRED | Three precise actions; see "Owner actions" |

## Production qualification ledger (6 October 2026, 10:35–10:50 UTC; candidate `77de9f7`)

Tags: VERIFIED / FAILED / BLOCKED / UNVERIFIED / INFERRED. **Decision: HOLD.** No code, DB, Render or Aiven mutation was made in this pass.

| Area | State |
|---|---|
| CURRENT CANDIDATE | VERIFIED: PR #29 open + draft + unmerged; head `77de9f73…` (remote re-read before and after); `main` `71614df…` unchanged; no other writer (no run or commit newer than 5 Oct 01:37 UTC); local tree clean |
| DEPLOYMENT | VERIFIED: Render `sakthiai-hitech-preview` live on `dep-db1g0449v7es73fctep0`, `autoDeploy: no`, `autoDeployTrigger: off`, `healthCheckPath: /healthz`, not suspended, no later deploy. `/releasez` **body** = full SHA `77de9f73048ffbab1d48b450db522500a7e98095`, `exactCommitKnown: true` |
| CI | VERIFIED (exact SHA, reused, not re-run): Quality Gate `37252140753` and PR gate `37252140651` PASS; unit 564/719, MySQL 161/161, E2E 48/48, audit 0 critical / 0 high, `ciShaBinding` PASS; 11 further PR workflows PASS. All workflows `permissions: contents: read`; no `pull_request_target` |
| DATABASE | **BLOCKED on repo secrets (not on Aiven).** Aiven is **VERIFIED by the owner (6 Oct, console)**: `hitech-preview-mysql` RUNNING, node running/master, database `sakthiai_preview` exists, MySQL 8.4.8, TLS required, newest full backup `2026-10-06T10:20:51.062938Z`; no migration authorized. **`mode=inspect` was dispatched at `77de9f7`** (run `37452499298`, job `112232141500`, recovery_point `2026-10-06T10:20:51.062938Z`, 10:51 UTC) and **failed at "Require preview database secrets": `SAKTHIAI_PREVIEW_DATABASE_URL is not configured`; the CA secret `AIVEN_MYSQL_CA_CERT_B64` also resolved empty** (both env values blank; a present secret is masked `***`). Every later step was skipped: the target guard, `pre`, snapshot and connectivity never ran, so **no database access occurred and no evidence artifact exists**. Classification A–H is **not possible yet**. Earlier note, kept for history: live `/readyz` (10:36 UTC) still gets past the DB probe and reports `schema_mismatch`, 31/31 tables missing. That is INFERRED and **not** proof of an empty database: it equally fits an empty target, wrong-schema visibility or app-user grants (class C vs F). Only the inspect snapshot can separate them. Old note: live `/readyz` (10:36 UTC) still gets past the DB probe and reports `schema_mismatch`, 31/31 tables missing. That is **not** proof of an empty database: a service mid-restore could answer with an empty schema, so no migration may be reasoned from it. The only `Preview DB Setup` run is the 5 Oct secrets-missing failure; no later dispatch, so repo-secret presence is UNVERIFIED. Inspect was **not** dispatched: the owner's rule is to wait for Aiven to report RUNNING. Classification A–H: **not yet possible** |
| READINESS | VERIFIED: `/healthz` 200; `/readyz` 503 `schema_mismatch`, counts only; `no-store` and `noindex` on `/readyz` and `/releasez`. UNVERIFIED: the `current` → 200 path live |
| AUTH | BLOCKED: `authentication: missing_configuration` (OIDC not entered). Nothing run |
| TENANT SECURITY | BLOCKED: needs DB + OIDC + two disposable users. Only the unauthenticated boundary is VERIFIED (16 probes, `unauth-probes-77de9f7.txt`) |
| STORAGE | BLOCKED: `storage: missing_configuration`; no upload/download/delete canary possible |
| CREATOR | UNVERIFIED live. VERIFIED in CI only: video routing, shot regeneration, assembly, seam and release contracts, source neutrality (no hidden Manus dependency in the shipped bundle). No provider is configured, so no spend is possible |
| BROWSER/A11Y | VERIFIED (CI, exact SHA): E2E 48/48 desktop + mobile, axe serious/critical enforced. VERIFIED live (5 Oct, `2ea4b4f`; runtime bundle unchanged since): landing axe 0 violations at 360/390/1440. UNVERIFIED: authenticated workspace, chat, provenance |
| SECURITY | VERIFIED live at `77de9f7`: HSTS, `nosniff`, `X-Frame-Options: SAMEORIGIN`, referrer and permissions policies; **no `X-Powered-By`**. **FAILED / P1: CSP is `report-only` and allows `'unsafe-inline'` and `'unsafe-eval'` in `script-src`.** UNVERIFIED: branch protection and rulesets (not readable with this session's tools) |
| ROLLBACK | VERIFIED targets exist (`dep-db1fjrpsrm7s73bf8lf0` `a9be03b`, `dep-db1e6jpsrm7s73b9bdm0`, `dep-dav0miaj7g8c73aakpg0`). Restore from the Aiven backup is UNTESTED |
| UNVERIFIED | Aiven state; recovery-point freshness; secrets; DB journal, schema and data; login; revocation and replay; two-tenant isolation; storage; retrieval and grounding; real LLM; Creator live; authenticated browser flows; branch protection |
| P0 BLOCKERS | (1) Preview DB not migrated (31/31 tables missing) and its state is unverified. (2) No auth configuration. (3) No LLM or storage. (4) Tenant isolation and revocation have no live evidence |
| P1 FOLLOW-UPS | Enforce CSP and drop `'unsafe-eval'`; restore drill; observability review once traffic exists; "W25 RECOVERY" landing eyebrow; >500 kB client chunk |
| FINAL DECISION | **HOLD** |

## Final state (exact SHAs)

| Item | Value |
|---|---|
| Remote integration head = tested head | `77de9f73048ffbab1d48b450db522500a7e98095` |
| Deployed preview (`/releasez`) | **`77de9f73048ffbab1d48b450db522500a7e98095`**, deploy `dep-db1g0449v7es73fctep0` (live at 01:42:30 UTC; `/readyz` 503 `database: schema_mismatch`, `databaseSchema {status: behind, expectedTables: 31, missingTables: 31, missingColumns: 0}`; worker and cleanup still `enabled: false`) |
| Previous deploys | `a9be03b` `dep-db1fjrpsrm7s73bf8lf0`; `ca6c369` `dep-db1eoefavr4c73bilfug`; `2ea4b4f` `dep-db1ecfnavr4c73bh0qg0` |
| Previous verified deploy | `7b240f7e40118982792f9cfaf03b248129042943`, deploy `dep-db1e6jpsrm7s73b9bdm0` (live from 23:39:28 UTC) |
| Previous verified deploys | `2ea4b4f` `dep-db1ecfnavr4c73bh0qg0` |
| Rollback target (pre-session) | `79fbe21d4289782ceba88c604fc0984a37d5632a`, deploy `dep-dav0miaj7g8c73aakpg0` |
| PR #29 | Open, **draft**, base `main` = `71614dfb2adc7b496d365d458fa5dab1a7f90c8c` (unchanged, not merged) |
| Imported qualified candidate | `bf2835bba3d65ee255501cbf8bcf4e045456a3af` (tree `53526012…`), unchanged |

Commits on top of the imported candidate. All were normal fast-forward pushes, each guarded by an expected-remote-head check:

| Commit | Type | Why |
|---|---|---|
| `aa0ee1c` | CI | Runs the existing migration manifest in the MySQL 8 job |
| `7b240f7` | test | Recovery suite gets the `{ timeout: 30_000 }` used by the other heavy SQL suites (shown flaky in run `37198546157`) |
| `c1fbb2b` | fix | **Observed on the deployed preview:** "Sign in securely" did nothing (an unhandled `startLogin()` rejection) and rendered with no fill (no `--color-primary` theme token). Now shows a `role=alert` message; the primary token maps to the existing `--deep` colour. E2E regression added; **it fails before the fix on desktop and mobile** and passes after |
| `2ea4b4f` | CI | Guards the existing `preview-db-setup.yml`: required recovery-point input; read-only journal-prefix pre-check; post-check for completeness and row preservation; rerun no-op; backfill run twice with the second updating 0; evidence upload |
| `ca6c369` | fix | Closes three guard gaps, each reproduced against `2ea4b4f`. (1) `recovery_point` matched only a prefix, so `2026-02-30T10:00` was ACCEPTED; it now requires a real, non-future UTC instant with `Z`. It is recorded as **OWNER_ATTESTED** (`providerVerified: false`, never BACKUP_VERIFIED), and `pre` fails if any TIMESTAMP `createdAt`/`updatedAt` row is newer than that point. (2) The journal check ignored hashes, so a tampered `__drizzle_migrations.hash` PASSED; each applied row must now equal the Drizzle migrator format (`hash` = sha256 of `drizzle/<tag>.sql`, `created_at` = journal `when`). This was confirmed against rows written by `pnpm db:push` (drizzle-kit). (3) The rerun step only repeated the completeness/minimum-count check; the new `rerun` mode requires journal rows, tables, columns, indexes, constraints and row counts to equal the `post` snapshot exactly |
| `a9be03b` | CI | `preview-db-setup.yml` gets a required `mode` input (`inspect` \| `migrate`, **default `inspect`**). Previously the workflow went straight from the read-only `pre` guard to `db:push`, so it had no safe preflight for secret presence or target inspection. `db:push`, the post/rerun guards and the backfill now run only with `mode=migrate`. A wiring regression test asserts this. Also verified locally that the workflow's unit-test step opens **no** connection to `DATABASE_URL` (MySQL general log) |
| `77de9f7` | fix | **Reproduced:** `/readyz` returned 200 `ready` with database `configured` for any reachable DB, including one stuck at 0004. Every procedure touching 0005–0010 tables (provider policies, OAuth login transactions, durable tasks, MCP, upload sessions) would then fail at request time, while readiness claimed success. Readiness now compares `information_schema.COLUMNS` with every table and column in the Drizzle schema. Anything missing gives 503 `database: "schema_mismatch"`, extra objects are allowed, and a read error gives `unknown` (not ready). The public body carries **counts only**; table names go to the server log. Built server, MySQL 8, baseline 0004: before the fix **200 ready**; after it **503**, 11 tables and 1 column missing; fully migrated: 200, schema `current`. Tests: 4 unit, 2 real-MySQL (0004 = behind, full = current), and the E2E readiness spec now asserts schema `current`. Health check stays `/healthz` (render.yaml), so deploys are unaffected

## CI evidence

| Head | Quality Gate (exact head, `workflow_dispatch`) | Quality Gate (PR merge ref) | Other PR workflows |
|---|---|---|---|
| `7b240f7` | `37198715132` PASS | `37198715877` PASS | 11/11 PASS |
| `c1fbb2b` | `37244899822` PASS | `37244897590` PASS | 11/11 PASS |
| `2ea4b4f` | `37245003799` **PASS** (release evidence `CI_VERIFIED_THIS_RUN`, `ciShaBinding=PASS`, E2E 48/48) | `37245003699` PASS | 11/11 PASS, plus Preview Deployment Preflight `37245000384` PASS |
| `ca6c369` | `37246358744` **PASS**: unit 559 passed / 153 skipped (712); MySQL **159/159** (14 files, including the 6 new guard cases); E2E 48/48; recovery 9/9; `ciShaBinding=PASS` | `37246359738` PASS | 11/11 PASS, plus Preview Deployment Preflight `37246355836` PASS |
| `a9be03b` | `37250216859` **PASS**: unit 560/713 (153 skipped), MySQL 159/159, E2E 48/48, `ciShaBinding=PASS` | `37250217554` PASS | PR check suite PASS |
| `77de9f7` | `37252140753` **PASS**: unit 564/719 (155 skipped, 88 files), MySQL **161/161** (15 files), E2E 48/48, migrations 11 (latest `0010_resumable_ingestion`), audit 0 critical / 0 high, every release-evidence gate PASS including `ciShaBinding`; `CI_VERIFIED_THIS_RUN`, `RUNTIME_UNVERIFIED` | `37252140651` PASS (validate, mysql-integration, e2e) | 11/11 PASS (session-cookie, file-ingestion, parallel-work, secret-hygiene, a11y semantics, smoke contract, focus-touch, beta truth, protected-main, grounding, preview contract) plus Preview Deployment Preflight `37252137350` PASS |

Exact-head gate contents, as established at `7b240f7` and re-run on every later head:

| Gate | Result |
|---|---|
| Frozen install, typecheck, build, neutrality | PASS |
| Unit suite | 682 tests (535 passed, 147 skipped) through `2ea4b4f`; **712 at `ca6c369`** (559 passed, 153 skipped). Skipped tests are MySQL-gated and run in `mysql-integration`; they are not double-counted |
| Real MySQL 8.0.46 | 153/153 through `2ea4b4f`; **159/159 at `ca6c369`** (+6 preview-guard cases); recovery rehearsal 9/9 |
| Migration manifest | 7/7: baseline 0004 → 0010; rerun no-op; data preserved; fresh-schema parity; backfill 2 → 0; search works |
| E2E | 46/46 at `7b240f7`; **48/48 at `2ea4b4f`** (adds the landing regression on desktop + mobile); serious/critical axe enforced |
| Contract evals / golden benchmark | 28/28 and 47/47 with 1 known gap (cross-lingual retrieval needs real embeddings). Not real-model evidence |
| Audit | 0 critical / 0 high (24 moderate, 5 low) |
| Release evidence | `CI_GATES_PASS`, `ciShaBinding=PASS`, `RUNTIME_UNVERIFIED` |

Local checks this session (Node 22, MySQL 8.0.46): auth and a11y E2E 32/32 with the fix; the new regression test fails without it; the unit suite gives the same 535/147; the accessibility-semantics, accessibility-shell, focus-touch, beta-capability, secret-hygiene and source-neutrality validators all PASS; the guarded preview-migration sequence passes; and the journal guard refuses out-of-order state.

## Preview database qualification (2026-10-05)

| Item | Observed |
|---|---|
| Aiven service | `hitech-preview-mysql`, project `ssakthivel02-7661`: **RUNNING** on `free-1-1gb` ($0), owner-checked in the console. This session has no Aiven access |
| Recovery point (**superseded twice**: `2026-10-05T12:28:44.420027Z`, then on 6 Oct the owner verified the newest full Aiven backup as **`2026-10-06T10:20:51.062938Z`**, which the guard accepts as `10:20:51.062Z`) | Earlier provider-listed backup `2026-10-05T00:28:42.354867Z`, after the 00:25 power-on. Passed **verbatim** as `recovery_point`, and GitHub records the raw input on the run. The guard compares at millisecond precision (`00:28:42.354Z`), 867 µs before the backup instant, which can only make the "rows newer than recovery point" check stricter. Evidence class: OWNER_ATTESTED / provider-listed. **Restore not tested** |
| Old 2026-10-02 backup | Not used |
| App connectivity | Verified-TLS `SELECT 1` succeeds against the expected `sakthiai_preview`. Through `a9be03b` that alone was reported as `database: configured`, the defect fixed in `77de9f7` |
| Guarded workflow, inspect | Run `37250477782` (job `111576895733`, SHA `a9be03b`) **failed at "Require preview database secrets"**: `SAKTHIAI_PREVIEW_DATABASE_URL` and `AIVEN_MYSQL_CA_CERT_B64` are both empty for this workflow. The target, `pre` guard and snapshot steps were skipped; no evidence artifact was produced |
| Schema of the live DB (read-only, from `77de9f7`) | `information_schema.COLUMNS` for `DATABASE()` = `sakthiai_preview`, as seen by the app user: **0 of 31 expected tables**, logged by name (`render-log-readiness-77de9f7.txt`). This contradicts the earlier assumption of a pre-0005 baseline. Either the DB is **empty** (then the migration applies all 11 migrations 0000–0010, and there are no rows to preserve), or its tables are **invisible to the app user** (a grants problem; the app would then fail on every query). The Day 1 `mode=inspect` run (the workflow's own credentials, `pre` snapshot of the journal and tables) decides which. The `__drizzle_migrations` journal itself was not inspected |
| Guard on an empty DB | Proven locally (MySQL 8.0.46, `77de9f7` source, same recovery point): attest PASS; `pre` PASS `applied=0/11`, all 11 pending; `db:push`; `post` PASS 11/11; second `db:push` + `rerun` PASS (exact snapshot equality); backfill `updated=0` twice (`local/guard-empty-db-77de9f7.txt`) |
| Migration 0005–0010, backfill | **Not run** |

## Runtime evidence (preview `srv-dao0vd8473hc73b1raag`)

Target identity: Render workspace `tea-danue82jnfac739th8lg`; service `sakthiai-hitech-preview`; free plan; Oregon; branch = PR #29 integration branch; **autoDeploy OFF (preserved)**. No other service was touched.

| Check (live; deployed `7b240f7`, then re-run on `2ea4b4f`) | Result |
|---|---|
| `/releasez` | 200, commit `7b240f7…`, `exactCommitKnown: true` |
| `/healthz` | 200. A cold start on the free plan can exceed 60 s |
| `/readyz` | 503: database `unavailable`; authentication, llm and storage `missing_configuration`; embeddings unavailable; scanner `not_configured`; **taskWorker and uploadCleanup `enabled: false`** |
| Unauthenticated tRPC (`workspace.list`, `chat.history`, `auth.logout`) | 401 UNAUTHORIZED |
| Forged session cookie | 401 |
| OAuth callback without state / with forged state | 400 / 403 `invalid oauth state` |
| `/api/oauth/begin` without a PKCE challenge | 400 `valid PKCE challenge required` |
| `/api/auth/revoke-all` without a session | 401 |
| Storage proxy, unauthenticated or with path traversal | 401 |
| 300 KiB body (limit 256 KiB) | 413 |
| Headers | HSTS, `nosniff`, `X-Frame-Options: SAMEORIGIN`, referrer and permissions policies. **CSP is report-only** (backlog, not a preview blocker) |
| Landing axe (wcag2a/aa, 2.1a/aa) at 360, 390 and 1440 px | **0 violations**, no horizontal overflow; copy truthfully states ingestion is disabled |
| Landing sign-in click (OIDC unconfigured) | On `7b240f7`: **defect** (no request, no message, transparent button). On `2ea4b4f`: **fixed live**. The button renders `rgb(23,59,46)` with white text, and clicking it shows `role=alert` "Sign-in is not configured on this deployment yet." |
| Re-run on `2ea4b4f` | `/releasez` = `2ea4b4f…`; every probe above returns the identical status; axe 0 violations at 360, 390 and 1440 px |
| `/readyz` after Aiven power-on (00:45 UTC, `ca6c369`) | 503 overall; **database `configured`**; authentication, llm and storage still `missing_configuration`; embeddings unavailable; scanner not configured; worker and cleanup `enabled: false`. **Known skew until the migration runs:** the app expects schema 0010, but the DB is presumably at the restored baseline (**superseded at `77de9f7`: the app user sees 0/31 tables**). No authenticated path is reachable, and I made no DB-writing request (for example `/api/oauth/begin`, which would write `oauthLoginTransactions`) |
| Re-run on `ca6c369` | `/releasez` = `ca6c369…`; all 16 probes return identical statuses; taskWorker and uploadCleanup still `enabled: false`. The runtime bundle is unchanged (the commit touches only CI, scripts and tests) |
| **`77de9f7`** (`dep-db1g0449v7es73fctep0`, 01:42 UTC) | `/releasez` = `77de9f7…`, `exactCommitKnown: true`. `/readyz` 503: `database: "schema_mismatch"`, `databaseSchema {behind, 31 expected, 31 missing, 0 columns}` (counts only in the public body); authentication, llm and storage `missing_configuration`; worker and cleanup `enabled: false`. The Render log names the 31 missing tables, with no error entries. All 16 unauthenticated probes return **identical statuses** to `ca6c369` (`unauth-probes-77de9f7.txt`) |

Raw evidence is in `release/evidence-20261005/runtime/`; local reproductions are in `release/evidence-20261005/local/`. Probe output contains no secrets.

These runtime checks verify the deployed artifact's identity and its unauthenticated boundary only. They do **not** verify authenticated isolation, revocation or data paths.

## Capability status

| Capability | SOURCE_IMPLEMENTED | LOCALLY_TESTED | CI_VERIFIED | RUNTIME_VERIFIED |
|---|---|---|---|---|
| Deploy provenance (`/releasez`), health, fail-closed readiness | Yes | Yes | Yes | **Yes** |
| Preview DB connectivity (verified TLS, expected DB name) | Yes | Yes | Yes | **Yes, connectivity only** (`SELECT 1`, 2026-10-05 00:45 UTC onward) |
| `/readyz` schema readiness: fail closed while the DB is behind the build (`77de9f7`) | Yes | Yes (4 unit, 2 real MySQL, built-server repro 0004 → 503, migrated → 200) | Yes (`37252140753`) | **Yes**: live 503 `schema_mismatch`, 0/31 tables visible (01:42 UTC). The `current` → 200 path is not yet live; it needs Day 1 |
| Unauthenticated denial, forged cookie/state, PKCE requirement, body limit, storage auth | Yes | Yes | Yes | **Yes (boundary only)** |
| Landing accessibility and mobile layout | Yes | Yes | Yes | **Yes (landing only)** |
| Preview-DB migration guard: attested recovery point, Drizzle hash/journal prefix, preservation, exact rerun no-op | Yes | Yes (30 tests, 6 on real MySQL 8.0.46; empty-DB sequence proven locally in session 4) | Yes (exact-head `37246358744` and `37252140753`) | No: repo secrets missing |
| Real OIDC login, logout, revocation, replay rejection | Yes | Yes (fake OIDC) | Yes | No: OIDC unconfigured |
| Two-user/workspace isolation, storage ownership | Yes | Yes | Yes | No: needs DB and login |
| Preview DB migration (0000–0010 if empty, else the pending suffix) and backfill | Yes | Yes | Yes | No: repo secrets missing; live schema shows 0/31 tables |
| Retrieval, citations, grounding states, Tamil/Tanglish | Yes | Yes (contract and synthetic vectors) | Yes | No |
| MODEL_UNAVAILABLE, self-hosted-first routing, opt-in, budgets, breaker | Yes | Yes | Yes | No: no LLM configured |
| Real LLM quality | n/a | No | No | **UNVERIFIED**: no endpoint |
| Real embeddings / semantic retrieval | Yes | Synthetic only | Synthetic only | **UNVERIFIED** |
| Uploads plus ClamAV | Yes | Fake scanner | Fake scanner | **UNVERIFIED**; flag OFF |
| Durable worker / `chat.sendAsync` | Yes | Yes | Yes (SQL) | No; flag OFF (verified live) |
| Read-only MCP | Yes | Fake server | Fake server | **UNVERIFIED**; flag OFF |

## Feature flags (live, preview)

`TASK_WORKER_ENABLED` and `UPLOAD_CLEANUP_ENABLED` are **OFF**, confirmed by `/readyz`. `FILE_INGESTION_BACKEND_ENABLED` and `MCP_CHAT_TOOLS_ENABLED` default OFF unless set to `true`; Render env values are not visible to this session, and nothing was changed. No flag was toggled in this session.

## Decision rationale

GO needs every mandatory gate for preview scope. Source and CI pass at every head. Deployed provenance and the unauthenticated boundary are runtime-verified.

Still missing: authenticated login and revocation, tenant isolation, migration of the preview DB, and live model and grounding behaviour. `/readyz` now proves the DB is not migrated (0/31 tables). Those are mandatory core gates, so the decision is **HOLD**.

CONDITIONAL GO is not offered. No safely limited scope exists, because without a database and login the preview cannot serve any core feature.

## Rollback (verified targets)

- **App:** Render dashboard → `sakthiai-hitech-preview` → Deploys → `dep-db1e6jpsrm7s73b9bdm0` (`7b240f7`) or `dep-dav0miaj7g8c73aakpg0` (`79fbe21`) → Rollback. The Render tooling in this session can only build the branch head, so a commit-specific rollback is a dashboard action. Never force-reset the branch.
- **Database:** nothing was migrated in this session. When migrating, the guarded workflow requires a recovery point first. Migrations are forward-only and **schema downgrade is NOT_SUPPORTED**. On failure: stop the app and workers, restore the Aiven recovery point into a fresh database, verify row counts, then repoint `DATABASE_URL`.
- **App (latest):** `dep-db1fjrpsrm7s73bf8lf0` (`a9be03b`) is the immediate predecessor of `77de9f7`. The only runtime difference is `/readyz` reporting the schema.
- **Source:** `c1fbb2b`, `2ea4b4f`, `ca6c369` and `77de9f7` can each be reverted with a normal revert commit.

## Owner actions (smallest set that unblocks runtime acceptance)

1. **Add the two repository secrets** (GitHub → Settings → Secrets and variables → Actions → *Repository secrets*; not environment-scoped, since the workflow declares no `environment:`):
   - `SAKTHIAI_PREVIEW_DATABASE_URL`: `mysql://<user>:<password>@hitech-preview-mysql-ssakthivel02-7661.h.aivencloud.com:<port>/sakthiai_preview`. Use the same service that the Render `DATABASE_URL` uses. The path must be `sakthiai_preview`.
   - `AIVEN_MYSQL_CA_CERT_B64`: the Aiven project CA certificate, base64-encoded, the same value as Render's `DATABASE_CA_CERT_B64`.
   - Then dispatch **"SakthiAI Preview DB Setup"** on the integration branch with `mode=inspect`, `recovery_point=2026-10-06T10:20:51.062938Z`, or ask Claude to. Only if every step passes, Claude produces a pre-migration evidence block; `mode=migrate` is dispatched once, after your explicit written approval, with the same recovery point.
   - If a write happens before the migration (for example someone logs in), take a newer Aiven backup and use its timestamp instead; the guard refuses rows newer than the recovery point.
   - **Expect an empty schema.** Live `/readyz` shows 0/31 tables. If you expected existing preview data in `sakthiai_preview`, say so before `migrate`. Then the inspect output decides: tables in the workflow's `pre` snapshot but invisible to the app means the Render `DATABASE_URL` user needs grants. An empty snapshot means a from-scratch 0000–0010 migration.
2. **OIDC, entered in the Render dashboard (never in chat):**
   - Runtime: `JWT_SECRET`, `OIDC_AUTHORIZATION_URL`, `OIDC_TOKEN_URL`, `OIDC_USERINFO_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, and `OIDC_REDIRECT_URI=https://sakthiai-hitech-preview.onrender.com/api/oauth/callback`.
   - **Build-time:** `VITE_OIDC_AUTHORIZATION_URL` and `VITE_OIDC_CLIENT_ID`. Changing these requires a redeploy.
   - Register the redirect URI with your provider, and provide two disposable test identities.
3. **Self-hosted LLM and storage**, only if a zero-cost instance already exists: `LOCAL_LLM_API_URL` and `LOCAL_LLM_MODEL`, and `STORAGE_ENDPOINT`, `STORAGE_BUCKET`, `STORAGE_ACCESS_KEY_ID` and `STORAGE_SECRET_ACCESS_KEY`. If none exists, these stay UNVERIFIED. Chat should then return MODEL_UNAVAILABLE truthfully, which can itself be verified live.

After 1–2: trigger a redeploy, then run live login, revoke-all, replay, two-tenant and storage-ownership acceptance, then retrieval and grounding, then re-issue this decision. The ordered schedule is in `SAKTHIAI_20_DAY_CONTINUATION_PLAN.md`, under "Active schedule: four dependency-driven days".

## Qualified scope vs. product backlog

This release lane qualifies the PR #29 core: auth/session security, tenancy, retrieval, grounding contracts, migrations and accessibility. It does **not** make every SakthiAI capability complete.

Backlog, outside this decision:
- Real-model quality and multilingual evaluation with human review
- Real embeddings, including the cross-lingual gap
- Live ClamAV and storage uploads
- Live MCP
- Creator video generation (paid providers excluded)
- Moving CSP from report-only to enforcing
- Removing the internal "W25 RECOVERY" eyebrow from the landing copy
- A >500 kB client chunk

OLD/LEGACY projects and Shiva were not touched.
