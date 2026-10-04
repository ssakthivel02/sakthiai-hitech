# SAKTHIAI FINAL RELEASE READINESS

**Decision: HOLD.** Exact-head CI is green, including MySQL 8 and migrations. Mandatory runtime evidence is missing.

Date: 4 October 2026. Scope: `ssakthivel02/sakthiai-hitech`, PR #29 combined candidate, release to the existing **preview** only. Production is out of scope.

This file supersedes the copy inside `sakthiai-release-qualification-evidence.zip` (archive sha256 `7a22ab5a…ec91`). That copy recorded the pre-integration state.

## Dashboard

| State | Item |
|---|---|
| COMPLETED | Archive retrieval by Drive ID and checksum verification; bundle import; fast-forward integration; exact-head CI green including MySQL 8, migration manifest, E2E and release evidence; read-only preview inspection |
| IN PROGRESS | None |
| BLOCKED | Runtime qualification. The preview runs the old head, its DB is unreachable, and OIDC/LLM/storage are unconfigured |
| PENDING | Preview deploy of `7b240f7`, preview DB migration 0005–0010 plus backfill, live auth/isolation/retrieval/grounding/a11y acceptance, real dependencies |
| OWNER ACTION REQUIRED | See "Owner actions" below: deploy authorization, Aiven power-on plus recovery point, dependency configuration |

| Evidence tier | Status for `7b240f7e40118982792f9cfaf03b248129042943` |
|---|---|
| SOURCE_IMPLEMENTED | Yes: original 0001–0020, 2 release repairs, 2 CI-only commits |
| LOCALLY_TESTED | Yes. Node 24 in the original handoff; this session re-ran MySQL 153/153, manifest 7/7 and typecheck on Node 22 with MySQL 8.0.46 |
| CI_VERIFIED | **Yes**, exact-head run `37198715132`, `ciShaBinding=PASS` |
| RUNTIME_VERIFIED | **No** |

## Exact SHAs

| Item | SHA |
|---|---|
| Remote integration head, which is also the tested head | `7b240f7e40118982792f9cfaf03b248129042943` |
| Imported qualified candidate | `bf2835bba3d65ee255501cbf8bcf4e045456a3af` (tree `53526012878491a9c2700cf99dea934878ff821d`, verified) |
| Original 0001–0020 candidate | `0dbf8107f023dd0719ca2587cb4c83c614b8b9b0` (tree `4afc3ac9c316111c26ffb3250279cf5897f6f0de`, verified) |
| Pre-integration baseline | `79fbe21d4289782ceba88c604fc0984a37d5632a` |
| Deployed preview (`/releasez`) | `79fbe21d4289782ceba88c604fc0984a37d5632a`, i.e. **not** the candidate |
| PR base (`main`) | `71614dfb2adc7b496d365d458fa5dab1a7f90c8c`; unchanged and not merged |

## Integration record

1. Archive fetched via Drive file ID `1cFU7KEp2CfI3r_glm_yiaPt6Z4CNe2qw`: 512,101 bytes, sha256 matched, all 31 `SHA256SUMS` entries OK.
2. `git bundle verify` OK. The bundle's only prerequisite is `79fbe21`, and the remote was confirmed still at `79fbe21` immediately before the push.
3. 22 linear commits with no merge commits. Both repair patches are patch-id-identical to `6665bab` and `bf2835b`.
4. Normal fast-forward pushes, each guarded by an expected-remote-head check:
   - `79fbe21..bf2835b`: the exact candidate.
   - `bf2835b..aa0ee1c`: CI-only change that wires the **existing** `scripts/migration-manifest.ts` into the `mysql-integration` job, because the 0005–0010 rehearsal previously ran only locally.
   - `aa0ee1c..7b240f7`: `rehearsal.mysql.test.ts` gets the same `{ timeout: 30_000 }` suite option as the other heavy MySQL suites. PR run `37198546157` showed "refuses unsafe restores", which builds up to 7 migrated scratch DBs, exceeding vitest's 5 s default under parallel load. No assertions changed.
5. No force push, no history rewrite, no main merge. PR #29 is still an open draft.

## CI evidence: exact head `7b240f7`

PR #29 is draft, open and `mergeable_state: clean`. Quality Gate runs twice: the PR run tests GitHub's generated merge commit, while the `workflow_dispatch` run checks out the exact head. Both passed.

| Run | Event | Tested ref | Result |
|---|---|---|---|
| Quality Gate `37198715132` | workflow_dispatch | `7b240f7` exact head; `release-evidence.json` `source.gitSha` and checkout `git log -1` confirm it | PASS |
| Quality Gate `37198715877` | pull_request | merge ref of `7b240f7` into `main` | PASS |
| 11 other PR workflows (Secret Hygiene, Session Cookie, Grounding, File Ingestion, Accessibility Semantics, Focus Touch, Beta Capability Truth, Preview Smoke/Contract, Protected Main, Parallel Work Guard) | pull_request | `7b240f7` | PASS |

Jobs in exact-head run `37198715132`: validate `111425797861`, mysql-integration `111425797928`, e2e `111425797984`, release-evidence `111426124217`. Environment: Node v22.23.3, pnpm 10.4.1 frozen install, MySQL 8.0.46 service container.

| Gate | CI result (exact head) |
|---|---|
| Frozen install / typecheck / build / source and dist neutrality | PASS |
| Unit suite | 682 tests in 85 files: 535 passed, **147 skipped**, 0 failed. The 147 skipped tests are MySQL-gated; with no DB in the `validate` job they run in `mysql-integration` instead. They are not hidden and not double-counted. Locally with a DB: 682/682 |
| Real MySQL 8 integration | **153/153**, 13 files, 0 skipped |
| Recovery rehearsal | 9/9 scenarios on 8.0.46. Included in the 153 |
| Migration manifest | **7/7**: baseline 0000–0004 applied, then 0005–0010 applied in order; rerun is a no-op; legacy data preserved; schema equals a fresh migration; backfill complete and idempotent (2 then 0); post-backfill search works. 0 destructive statements in 0005–0010 |
| Migration consistency | 11 migrations; journal, SQL and schema consistent; forward-only |
| E2E (Playwright, built server, MySQL 8, fake OIDC/LLM/S3/clamd) | **46/46**, 0 flaky, 0 skipped |
| Accessibility | Serious and critical axe findings are enforced by the E2E gate and pass. This is not full WCAG certification |
| Contract evals | 28/28 (`CONTRACT_HARNESS`, `realModelQuality: NOT_MEASURED`) |
| Golden benchmark | 47/47, with 1 known gap: cross-lingual retrieval needs embeddings; vectors are synthetic |
| Secret hygiene | PASS (505 tracked paths) |
| Production advisories | 0 critical, 0 high (24 moderate, 5 low) |
| Built-server smoke | `/healthz` 200, SPA shell served, `/readyz` 503 fail-closed |
| Release evidence | `CI_GATES_PASS`, `CI_VERIFIED_THIS_RUN`, `RUNTIME_UNVERIFIED`, `ciShaBinding=PASS` |

The MySQL 8 coverage spans tenant/workspace isolation and creation races, session generation/revocation, storage ownership, retrieval text and transliteration, provider policy/budgets/breakers, task claim/lease/renewal/cancel/graceful stop/crash recovery/idempotency, upload lifecycle and cleanup, OAuth login transactions, the read-only MCP policy (mutation tools never offered), migrations 0005–0010, and backfill.

## Preview: read-only inspection, no changes made

| Item | Observed |
|---|---|
| Render workspace | `tea-danue82jnfac739th8lg` ("My Workspace"), the only workspace |
| Service | `sakthiai-hitech-preview` (`srv-dao0vd8473hc73b1raag`): free plan, Oregon, branch = PR #29 integration branch, **autoDeploy off**, health check `/healthz` |
| Live deploy | `dep-dav0miaj7g8c73aakpg0` at `79fbe21`, finished 2026-10-01 07:30 UTC |
| `/healthz` | 200 `alive`. The first probe timed out during a free-plan cold start |
| `/releasez` | 200, commit `79fbe21…`, `exactCommitKnown: true` |
| `/readyz` | **503**: `database: unavailable`, `authentication`, `llm` and `storage`: `missing_configuration`, embeddings unavailable, scanner `not_configured`, file ingestion `coming_soon` |
| Other services | `divyanexus-ask-staging` belongs to a different repo and was not touched |

No deploy, env change, Aiven power-on or migration was performed. Preview runtime acceptance was **not run**: the candidate is not deployed, the DB is unreachable, and real authentication is not configured, so login/logout, revocation, isolation, retrieval and grounding cannot be exercised live.

## Real dependencies

| Dependency | Status |
|---|---|
| Self-hosted LLM | **UNVERIFIED**: preview reports `missing_configuration`. Contract evals are not real-model evidence |
| Embedding model | **UNVERIFIED**: lexical fallback and synthetic-vector contracts pass; the English-to-Tamil semantic gap remains |
| OIDC | **UNVERIFIED**: preview `missing_configuration` |
| Object storage | **UNVERIFIED**: preview `missing_configuration` |
| ClamAV | **UNVERIFIED**: `not_configured`. Uploads must stay disabled |
| Durable worker | CI SQL behaviour verified; deployed worker **UNVERIFIED** |
| Read-only MCP endpoint | Policy verified in CI against a fake server; real endpoint **UNVERIFIED** |
| English/Tamil/mixed/Tanglish quality, insufficient evidence, provider failure, cross-tenant attempts | Contract and SQL evidence only; live testing pending |

## Feature flags

None were changed. Uploads, the worker, MCP chat tools and cleanup stay under their existing flags. Uploads must remain disabled until both the real scanner and storage pass acceptance.

## Decision rationale

GO requires every mandatory gate for the stated scope. Source and CI gates are now met at the exact head. The mandatory preview runtime gates are not met: live auth/revocation/isolation, DB migration on the preview DB, `/releasez` showing the candidate, and real-dependency behaviour. That makes the decision **HOLD**. A CONDITIONAL GO would hide a core runtime gap, so it is not used.

## Rollback

- **App:** the preview's current live deploy is `79fbe21` (`dep-dav0miaj7g8c73aakpg0`). If a later candidate deploy fails acceptance, redeploy that commit through Render's manual deploy. Never force-reset the Git branch.
- **Database:** migrations are forward-only and **schema downgrade is NOT_SUPPORTED**. Before migrating the preview DB, take or confirm an Aiven recovery point and check that `__drizzle_migrations` holds exactly 5 rows (baseline 0004). On failure: stop writes and workers, restore the recovery point into a fresh approved DB, verify row counts and checksums, then switch over. Writes made after the backup can be lost. The 9-scenario CI rehearsal is not a production RTO/RPO guarantee.
- **CI-only commits** `aa0ee1c` and `7b240f7` change only the workflow and a test timeout. Reverting them, with a normal revert commit, does not affect runtime behaviour.

## Owner actions (required for runtime qualification)

1. **Authorize a preview deploy** of exactly `7b240f7e40118982792f9cfaf03b248129042943` to `sakthiai-hitech-preview`. I can trigger it through Render once you approve. This is a preview, not production.
2. **Power on `hitech-preview-mysql` (Aiven)** and confirm a fresh recovery point. This session has no Aiven access, so this must be done by you. Before the migration step, confirm the DB name is `sakthiai_preview` with TLS on.
3. **Configure the existing zero-cost dependencies** (OIDC, self-hosted LLM endpoint, object storage, and optionally the embedding endpoint and ClamAV). Enter the values directly in the Render dashboard environment; never paste secrets into chat. Any dependency that doesn't exist stays UNVERIFIED and blocks GO for that capability.
4. **Main merge and production deploy are not requested** and stay prohibited.

After steps 1–3: re-login disposable identities, run the live two-tenant/adversarial and revoke-all acceptance, check grounding and MODEL_UNAVAILABLE, run the Tamil/Tanglish checks, run mobile and axe checks against the preview, then re-issue this decision.

OLD/LEGACY projects and the Shiva website were not touched.
