# SAKTHIAI FINAL RELEASE READINESS

**Decision: HOLD.** This is a preview-scope release.

The CI-qualified candidate is now **deployed to the existing preview**, and its deployed provenance, unauthenticated security boundary and landing accessibility are **runtime-verified**.

Core runtime acceptance is still **not verified**: real login, session revocation, two-tenant isolation, retrieval, grounding and the real model. The preview database is unreachable, and OIDC, LLM and storage are unconfigured. Those can only be cleared by owner actions.

Updated 5 October 2026, 01:16 UTC (sessions 23:35–23:53, 00:03–00:18 and 01:06–01:17 UTC). Scope: `ssakthivel02/sakthiai-hitech`, PR #29 combined candidate, release to the existing **preview** only. Production, merging to `main` and paid providers are out of scope.

This file supersedes earlier versions: `bdb11a1` on this branch, and the copy inside `sakthiai-release-qualification-evidence.zip`.

## Dashboard

| State | Item |
|---|---|
| COMPLETED | Reconciliation (no other writer; source and preview state matched the record). Controlled preview deploys of CI-qualified `7b240f7`, then `2ea4b4f`; `/releasez` provenance verified for both. Live unauthenticated security probes. Live axe/mobile landing scan. Demonstrated landing-page defects fixed with a regression test. Existing preview-DB migration workflow given recovery-point, journal, preservation, rerun and backfill guards, rehearsed on MySQL 8. **Session 3:** three demonstrated guard gaps fixed in `ca6c369` (invalid dates accepted; migration hashes unchecked; rerun not compared to a snapshot), with 30 new regression tests including 6 on real MySQL |
| IN PROGRESS | None. Changes frozen at `a9be03b`; see Final state |
| BLOCKED | **Preview DB migration: the GitHub repo secrets are missing.** Aiven `hitech-preview-mysql` is RUNNING on `free-1-1gb` (owner-checked in the console), with a provider-listed backup at `2026-10-05T00:28:42.354867Z` (after the 00:25 power-on; a restore of it has **not** been tested). `/readyz` reports `database: configured`. The guarded workflow, dispatched in read-only `mode=inspect` with that exact timestamp (run `37250477782`, job `111576895733`, checked-out SHA `a9be03b`), **stopped at its first check**: `SAKTHIAI_PREVIEW_DATABASE_URL is not configured`. Both secret values resolved empty (GitHub masks present secrets as `***`). No guard step ran and **no database access occurred**. `migrate` was not dispatched. OIDC, LLM and storage also still need secure owner entry |
| PENDING | Preview DB inspect + migration 0005–0010 + backfill (blocked on secrets); live login/logout/revocation/replay; two-user isolation; storage ownership; retrieval, citations and grounding; Tamil/Tanglish; MODEL_UNAVAILABLE live; worker, uploads and MCP. See `SAKTHIAI_20_DAY_CONTINUATION_PLAN.md` |
| OWNER ACTION REQUIRED | Three precise actions; see "Owner actions" |

## Final state (exact SHAs)

| Item | Value |
|---|---|
| Remote integration head = tested head | `a9be03bc8f938c83deb4abcc8cb3c152950223a7` |
| Deployed preview (`/releasez`) | **`a9be03bc8f938c83deb4abcc8cb3c152950223a7`**, deploy `dep-db1fjrpsrm7s73bf8lf0` (verified 01:16:15 UTC; `/readyz` database `configured`, worker and cleanup still `enabled: false`) |
| Previous deploys | `ca6c369` `dep-db1eoefavr4c73bilfug`; `2ea4b4f` `dep-db1ecfnavr4c73bh0qg0` |
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

## CI evidence

| Head | Quality Gate (exact head, `workflow_dispatch`) | Quality Gate (PR merge ref) | Other PR workflows |
|---|---|---|---|
| `7b240f7` | `37198715132` PASS | `37198715877` PASS | 11/11 PASS |
| `c1fbb2b` | `37244899822` PASS | `37244897590` PASS | 11/11 PASS |
| `2ea4b4f` | `37245003799` **PASS** (release evidence `CI_VERIFIED_THIS_RUN`, `ciShaBinding=PASS`, E2E 48/48) | `37245003699` PASS | 11/11 PASS, plus Preview Deployment Preflight `37245000384` PASS |
| `ca6c369` | `37246358744` **PASS**: unit 559 passed / 153 skipped (712); MySQL **159/159** (14 files, including the 6 new guard cases); E2E 48/48; recovery 9/9; `ciShaBinding=PASS` | `37246359738` PASS | 11/11 PASS, plus Preview Deployment Preflight `37246355836` PASS |
| `a9be03b` | `37250216859` **PASS**: unit 560/713 (153 skipped), MySQL 159/159, E2E 48/48, `ciShaBinding=PASS` | `37250217554` PASS | PR check suite PASS |

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
| Recovery point | Provider-listed backup `2026-10-05T00:28:42.354867Z`, after the 00:25 power-on. Passed **verbatim** as `recovery_point`, and GitHub records the raw input on the run. The guard compares at millisecond precision (`00:28:42.354Z`), 867 µs before the backup instant, which can only make the "rows newer than recovery point" check stricter. Evidence class: OWNER_ATTESTED / provider-listed. **Restore not tested** |
| Old 2026-10-02 backup | Not used |
| App connectivity | `/readyz` reports `database: configured`: verified-TLS `SELECT 1` succeeds against the expected `sakthiai_preview` |
| Guarded workflow, inspect | Run `37250477782` (job `111576895733`, SHA `a9be03b`) **failed at "Require preview database secrets"**: `SAKTHIAI_PREVIEW_DATABASE_URL` and `AIVEN_MYSQL_CA_CERT_B64` are both empty for this workflow. The target, `pre` guard and snapshot steps were skipped; no evidence artifact was produced |
| Journal/schema of the live DB | **Not inspected**: no read-only route exists without those secrets. The app expects 0010; the DB presumably holds the pre-0005 state restored from backup |
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
| `/readyz` after Aiven power-on (00:45 UTC, `ca6c369`) | 503 overall; **database `configured`**; authentication, llm and storage still `missing_configuration`; embeddings unavailable; scanner not configured; worker and cleanup `enabled: false`. **Known skew until the migration runs:** the app expects schema 0010, but the DB is presumably at the restored baseline. No authenticated path is reachable, and I made no DB-writing request (for example `/api/oauth/begin`, which would write `oauthLoginTransactions`) |
| Re-run on `ca6c369` | `/releasez` = `ca6c369…`; all 16 probes return identical statuses; taskWorker and uploadCleanup still `enabled: false`. The runtime bundle is unchanged (the commit touches only CI, scripts and tests) |

Raw evidence is in `release/evidence-20261005/runtime/`. Probe output contains no secrets.

These runtime checks verify the deployed artifact's identity and its unauthenticated boundary only. They do **not** verify authenticated isolation, revocation or data paths.

## Capability status

| Capability | SOURCE_IMPLEMENTED | LOCALLY_TESTED | CI_VERIFIED | RUNTIME_VERIFIED |
|---|---|---|---|---|
| Deploy provenance (`/releasez`), health, fail-closed readiness | Yes | Yes | Yes | **Yes** |
| Preview DB connectivity (verified TLS, expected DB name) | Yes | Yes | Yes | **Yes, connectivity only** (`/readyz` `database: configured`, 2026-10-05 00:45 UTC). Schema, journal and data are not inspected |
| Unauthenticated denial, forged cookie/state, PKCE requirement, body limit, storage auth | Yes | Yes | Yes | **Yes (boundary only)** |
| Landing accessibility and mobile layout | Yes | Yes | Yes | **Yes (landing only)** |
| Preview-DB migration guard: attested recovery point, Drizzle hash/journal prefix, preservation, exact rerun no-op | Yes | Yes (30 tests; 6 on real MySQL 8.0.46) | Yes (exact-head `37246358744`: MySQL 159/159) | No: DB unreachable |
| Real OIDC login, logout, revocation, replay rejection | Yes | Yes (fake OIDC) | Yes | No: OIDC unconfigured |
| Two-user/workspace isolation, storage ownership | Yes | Yes | Yes | No: needs DB and login |
| Migrations 0005–0010 and backfill on the preview DB | Yes | Yes | Yes | No: DB unreachable |
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

Still missing: authenticated login and revocation, tenant isolation, migration of the preview DB, and live model and grounding behaviour. Those are mandatory core gates, so the decision is **HOLD**.

CONDITIONAL GO is not offered. No safely limited scope exists, because without a database and login the preview cannot serve any core feature.

## Rollback (verified targets)

- **App:** Render dashboard → `sakthiai-hitech-preview` → Deploys → `dep-db1e6jpsrm7s73b9bdm0` (`7b240f7`) or `dep-dav0miaj7g8c73aakpg0` (`79fbe21`) → Rollback. The Render tooling in this session can only build the branch head, so a commit-specific rollback is a dashboard action. Never force-reset the branch.
- **Database:** nothing was migrated in this session. When migrating, the guarded workflow requires a recovery point first. Migrations are forward-only and **schema downgrade is NOT_SUPPORTED**. On failure: stop the app and workers, restore the Aiven recovery point into a fresh database, verify row counts, then repoint `DATABASE_URL`.
- **Source:** `c1fbb2b`, `2ea4b4f` and `ca6c369` can each be reverted with a normal revert commit.

## Owner actions (smallest set that unblocks runtime acceptance)

1. **Add the two repository secrets** (GitHub → Settings → Secrets and variables → Actions → *Repository secrets*; not environment-scoped, since the workflow declares no `environment:`):
   - `SAKTHIAI_PREVIEW_DATABASE_URL`: `mysql://<user>:<password>@hitech-preview-mysql-ssakthivel02-7661.h.aivencloud.com:<port>/sakthiai_preview`. Use the same service that the Render `DATABASE_URL` uses. The path must be `sakthiai_preview`.
   - `AIVEN_MYSQL_CA_CERT_B64`: the Aiven project CA certificate, base64-encoded, the same value as Render's `DATABASE_CA_CERT_B64`.
   - Then dispatch **"SakthiAI Preview DB Setup"** on the integration branch with `mode=inspect`, `recovery_point=2026-10-05T00:28:42.354867Z`, or ask Claude to. Only if every step passes, dispatch once more with `mode=migrate` and the same recovery point.
   - If a write happens before the migration (for example someone logs in), take a newer Aiven backup and use its timestamp instead; the guard refuses rows newer than the recovery point.
2. **OIDC, entered in the Render dashboard (never in chat):**
   - Runtime: `JWT_SECRET`, `OIDC_AUTHORIZATION_URL`, `OIDC_TOKEN_URL`, `OIDC_USERINFO_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, and `OIDC_REDIRECT_URI=https://sakthiai-hitech-preview.onrender.com/api/oauth/callback`.
   - **Build-time:** `VITE_OIDC_AUTHORIZATION_URL` and `VITE_OIDC_CLIENT_ID`. Changing these requires a redeploy.
   - Register the redirect URI with your provider, and provide two disposable test identities.
3. **Self-hosted LLM and storage**, only if a zero-cost instance already exists: `LOCAL_LLM_API_URL` and `LOCAL_LLM_MODEL`, and `STORAGE_ENDPOINT`, `STORAGE_BUCKET`, `STORAGE_ACCESS_KEY_ID` and `STORAGE_SECRET_ACCESS_KEY`. If none exists, these stay UNVERIFIED. Chat should then return MODEL_UNAVAILABLE truthfully, which can itself be verified live.

After 1–2: trigger a redeploy, then run live login, revoke-all, replay, two-tenant and storage-ownership acceptance, then retrieval and grounding, then re-issue this decision.

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
