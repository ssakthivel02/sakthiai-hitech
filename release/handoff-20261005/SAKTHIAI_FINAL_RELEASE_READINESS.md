# SAKTHIAI FINAL RELEASE READINESS

**Decision: HOLD.** This is a preview-scope release.

The CI-qualified candidate is now **deployed to the existing preview**, and its deployed provenance, unauthenticated security boundary and landing accessibility are **runtime-verified**.

Core runtime acceptance is still **not verified**: real login, session revocation, two-tenant isolation, retrieval, grounding and the real model. The preview database is unreachable, and OIDC, LLM and storage are unconfigured. Those can only be cleared by owner actions.

Updated 5 October 2026, 00:00–02:35 UTC session. Scope: `ssakthivel02/sakthiai-hitech`, PR #29 combined candidate, release to the existing **preview** only. Production, merging to `main` and paid providers are out of scope.

This file supersedes earlier versions: `bdb11a1` on this branch, and the copy inside `sakthiai-release-qualification-evidence.zip`.

## Dashboard

| State | Item |
|---|---|
| COMPLETED | Reconciliation (no other writer; source and preview state matched the record). Controlled preview deploys of CI-qualified `7b240f7`, then `2ea4b4f`; `/releasez` provenance verified for both. Live unauthenticated security probes. Live axe/mobile landing scan. Demonstrated landing-page defects fixed with a regression test. Existing preview-DB migration workflow given recovery-point, journal, preservation, rerun and backfill guards, rehearsed on MySQL 8 |
| IN PROGRESS | None. Changes are frozen at `2ea4b4f`, which is CI-verified, deployed and runtime-checked |
| BLOCKED | Preview DB (Aiven: no access from this session, billing unknown); OIDC, LLM and storage configuration (secure owner entry required) |
| PENDING | Preview DB migration 0005–0010 plus backfill; live login/logout/revocation/replay; two-user isolation; storage ownership; retrieval, citations and grounding states; Tamil/Tanglish live answers; MODEL_UNAVAILABLE and provider routing live; worker, uploads and MCP live |
| OWNER ACTION REQUIRED | Three precise actions; see "Owner actions" |

## Final state (exact SHAs)

| Item | Value |
|---|---|
| Remote integration head = tested head | `2ea4b4f6909dfc11f3084d8294e016531b96b1c5` |
| Deployed preview (`/releasez`) | **`2ea4b4f6909dfc11f3084d8294e016531b96b1c5`**, deploy `dep-db1ecfnavr4c73bh0qg0` (live 23:52:20 UTC) |
| Previous verified deploy | `7b240f7e40118982792f9cfaf03b248129042943`, deploy `dep-db1e6jpsrm7s73b9bdm0` (live from 23:39:28 UTC) |
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

## CI evidence

| Head | Quality Gate (exact head, `workflow_dispatch`) | Quality Gate (PR merge ref) | Other PR workflows |
|---|---|---|---|
| `7b240f7` | `37198715132` PASS | `37198715877` PASS | 11/11 PASS |
| `c1fbb2b` | `37244899822` PASS | `37244897590` PASS | 11/11 PASS |
| `2ea4b4f` | `37245003799` **PASS** (release evidence `CI_VERIFIED_THIS_RUN`, `ciShaBinding=PASS`, E2E 48/48) | `37245003699` PASS | 11/11 PASS, plus Preview Deployment Preflight `37245000384` PASS |

Exact-head gate contents, as established at `7b240f7` and re-run on every later head:

| Gate | Result |
|---|---|
| Frozen install, typecheck, build, neutrality | PASS |
| Unit suite | 682 tests: 535 passed, 147 skipped. The skipped tests are MySQL-gated and run in `mysql-integration`; they are not double-counted |
| Real MySQL 8.0.46 | 153/153, including recovery rehearsal 9/9 |
| Migration manifest | 7/7: baseline 0004 → 0010; rerun no-op; data preserved; fresh-schema parity; backfill 2 → 0; search works |
| E2E | 46/46 at `7b240f7`; **48/48 at `2ea4b4f`** (adds the landing regression on desktop + mobile); serious/critical axe enforced |
| Contract evals / golden benchmark | 28/28 and 47/47 with 1 known gap (cross-lingual retrieval needs real embeddings). Not real-model evidence |
| Audit | 0 critical / 0 high (24 moderate, 5 low) |
| Release evidence | `CI_GATES_PASS`, `ciShaBinding=PASS`, `RUNTIME_UNVERIFIED` |

Local checks this session (Node 22, MySQL 8.0.46): auth and a11y E2E 32/32 with the fix; the new regression test fails without it; the unit suite gives the same 535/147; the accessibility-semantics, accessibility-shell, focus-touch, beta-capability, secret-hygiene and source-neutrality validators all PASS; the guarded preview-migration sequence passes; and the journal guard refuses out-of-order state.

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

Raw evidence is in `release/evidence-20261005/runtime/`. Probe output contains no secrets.

These runtime checks verify the deployed artifact's identity and its unauthenticated boundary only. They do **not** verify authenticated isolation, revocation or data paths.

## Capability status

| Capability | SOURCE_IMPLEMENTED | LOCALLY_TESTED | CI_VERIFIED | RUNTIME_VERIFIED |
|---|---|---|---|---|
| Deploy provenance (`/releasez`), health, fail-closed readiness | Yes | Yes | Yes | **Yes** |
| Unauthenticated denial, forged cookie/state, PKCE requirement, body limit, storage auth | Yes | Yes | Yes | **Yes (boundary only)** |
| Landing accessibility and mobile layout | Yes | Yes | Yes | **Yes (landing only)** |
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
- **Source:** `c1fbb2b` and `2ea4b4f` can each be reverted with a normal revert commit.

## Owner actions (smallest set that unblocks runtime acceptance)

1. **Aiven `hitech-preview-mysql`.** This session has no Aiven access. Confirm whether powering it on starts or increases billing; if it does, decide. Then power it on and take or confirm a backup. Ensure repo secrets `SAKTHIAI_PREVIEW_DATABASE_URL` and `AIVEN_MYSQL_CA_CERT_B64` are set, and Render env `DATABASE_URL`, `DATABASE_EXPECTED_NAME=sakthiai_preview` and `DATABASE_CA_CERT_B64`. Then run **Actions → "SakthiAI Preview DB Setup"** on the integration branch with `recovery_point=<backup UTC, e.g. 2026-10-05T01:10>`. The guards stop on any unexpected journal state.
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
