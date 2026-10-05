# SakthiAI HI-TECH: 20-day continuation plan (PR #29 preview release)

Start date: 5 October 2026. **The active order is the four-day schedule below**; the Days 1–20 sections hold the detailed acceptance criteria. Planned work only: **nothing here is complete until its acceptance evidence exists.**

Release scope: the existing preview (`sakthiai-hitech-preview`) running the CI-verified PR #29 head. Production deployment and merging to `main` are separate owner decisions (Days 19–20).

**Legend:**
- **[OWNER]**: needs owner credentials, console access, approval or test identities.
- **[OWNER-PAID]**: would need spending. It is not planned, and the work stays UNVERIFIED unless the owner explicitly approves.
- **Stop condition**: when it is hit, stop that track, record the blocker in `SAKTHIAI_FINAL_RELEASE_READINESS.md`, and continue with independent tracks.

Global rules for every day:
- One writer.
- Fast-forward pushes only, followed by exact-head Quality Gate CI.
- Redeploy only CI-verified heads, then confirm `/releasez`.
- Keep the worker, uploads, cleanup and MCP flags OFF except during a bounded qualification window.
- Never put secret values in chat or in Git.

## Dependency graph

```
D1-2 preview DB inspect -> migrate ──┐
                                     ├─> D4-6 auth/session/isolation ─> D7-9 documents/retrieval/grounding ─┐
D1-3 OIDC configured [OWNER] ────────┘                                                                       ├─> D16-18 final readiness ─> D19-20 release prep [OWNER]
D3 LLM/storage availability [OWNER] ─> D10-12 model + storage ─> D13-15 controlled worker/uploads/MCP ───────┘
```

## Active schedule: four dependency-driven days (updated 5 October 2026)

This compresses the tracks below into four working days. The detailed acceptance tables in the Days 1–20 sections still apply; this section only sets the order and the gates. **Each day starts only when its prerequisite gate is met. If it is not met, the day does not start, and the blocker is recorded rather than worked around.** Nothing in this section is complete until its evidence exists in `SAKTHIAI_FINAL_RELEASE_READINESS.md`.

New since the 20-day plan: from `77de9f7`, `/readyz` compares the live schema with the build. It reports `database: "schema_mismatch"` with `databaseSchema: {status:"behind", missingTables:<n>, missingColumns:<n>}` until the pending migrations are applied (live at `77de9f7`: 31/31 tables missing), and the table names appear in the Render log line `readiness: database schema behind this build`. That gives a secret-free, read-only before/after check for Day 1.

### Day 1: secrets → inspect → migrate once

| | |
|---|---|
| **Prerequisite (owner)** | Repo secrets `SAKTHIAI_PREVIEW_DATABASE_URL` and `AIVEN_MYSQL_CA_CERT_B64` exist (GitHub → Settings → Secrets and variables → Actions → Repository secrets). Aiven `hitech-preview-mysql` is RUNNING. The latest provider-listed backup timestamp is quoted verbatim (`2026-10-05T00:28:42.354867Z` unless the DB has been written since; if it has, take a new backup and use that) |
| **Before** | `/releasez` = deployed head; `/readyz` `databaseSchema.status` = `behind`. **Observed at `77de9f7` (01:42 UTC): 31/31 tables missing**, so the DB is empty or its tables are invisible to the app user |
| **Action 1** | Dispatch "SakthiAI Preview DB Setup", `mode=inspect`, same `recovery_point`. Read-only |
| **Gate** | Secrets step, Aiven target guard, `attest` and `pre` all PASS. The applied journal is a valid hash-checked prefix (expected `applied=0/11` on an empty DB, proven locally), `rowsNewerThanRecoveryPoint = {}`, and the `preview-migration-pre.json` artifact exists. **Any FAIL: stop Day 1, do not dispatch `migrate`** |
| **Action 2** | Dispatch `mode=migrate` with the same `recovery_point`, **once** |
| **Gate (stop)** | If `pre` shows **tables or journal rows that the app's `/readyz` cannot see**, the Render `DATABASE_URL` user lacks grants. Stop: owner fixes the grants first, and no migration runs |
| **Acceptance** | Pre/post/rerun guards PASS; all pending migrations applied in order (0000–0010 on an empty DB); backfill reports N, then 0; artifact uploaded. **Live `/readyz`: `database: "configured"`, `databaseSchema: {status:"current", missingTables:0, missingColumns:0}`**; no new error logs |
| **Rollback** | Stop the app (suspend the preview), restore the recovery point into a **new** Aiven DB, verify row counts, and repoint `DATABASE_URL`. Schema downgrade is NOT_SUPPORTED. Never re-run `migrate` after a partial failure without a new recovery point |
| **Restore drill** | Only if a $0 restore target exists; otherwise record UNTESTED. A listed backup is not a tested restore |

### Day 2: OIDC, two test accounts, auth and isolation

| | |
|---|---|
| **Prerequisite** | Day 1 accepted (schema `current`). Owner has entered the OIDC values in Render (runtime `JWT_SECRET`, `OIDC_*`, `OIDC_REDIRECT_URI`; build-time `VITE_OIDC_AUTHORIZATION_URL`, `VITE_OIDC_CLIENT_ID`), registered the redirect URI, and created **two disposable identities A and B**, held by the owner and never shared in chat |
| **Action** | Redeploy the CI-verified head (VITE values are baked in at build). Confirm `/releasez` and `/readyz` `authentication: configured`. Owner signs in as A and B in the browser. **The owner runs** the existing live acceptance script in their own shell, so that session tokens never enter chat or Git: `SAKTHIAI_BASE_URL=https://sakthiai-hitech-preview.onrender.com SAKTHIAI_EXPECTED_SHA=<deployed sha> SAKTHIAI_USER_A_TOKEN=… SAKTHIAI_USER_B_TOKEN=… SAKTHIAI_USER_A_WORKSPACE_ID=… SAKTHIAI_USER_B_WORKSPACE_ID=… SAKTHIAI_USER_A_CONVERSATION_ID=… SAKTHIAI_USER_B_CONVERSATION_ID=… pnpm exec tsx scripts/core-runtime-security-acceptance.ts`. Revocation and write checks additionally need `SAKTHIAI_ALLOW_REVOCATION=true`, `SAKTHIAI_ALLOW_ACCEPTANCE_WRITES=true` and `SAKTHIAI_ACCEPTANCE_WORKSPACE_ID`, set on disposable accounts only. The owner shares only the PASS/FAIL output. Claude covers the browser-side rows of the Days 4–6 table: PKCE/state, safe `returnTo`, HttpOnly/SameSite cookie, logout and revoke-all replay rejected (401), B denied on A's workspace, project, document, chat, task and MCP IDs |
| **Acceptance** | Every row of the Days 4–6 table has live evidence; axe 0 serious/critical on the authenticated workspace at 390 and 1440 px |
| **Stop** | Any cross-tenant read or write, or an accepted replayed session, is a release blocker: fix with a regression test, run exact-head CI, redeploy, and re-run Day 2 |
| **Rollback** | Remove the OIDC values in Render and redeploy; the landing then truthfully reports "Sign-in is not configured" |

### Day 3: LLM, embeddings and storage (only zero-cost ones)

| | |
|---|---|
| **Prerequisite** | Day 2 accepted. Owner confirms whether a **zero-cost** self-hosted OpenAI-compatible LLM (`LOCAL_LLM_API_URL`, `LOCAL_LLM_MODEL`), embeddings (`LOCAL_EMBEDDING_*`) and S3-compatible storage (`STORAGE_*`) already exist |
| **If none exist** | Verify live that `chat.send` returns MODEL_UNAVAILABLE truthfully and that disabled-upload messages are truthful. Real-model quality, semantic retrieval and storage stay **UNVERIFIED**. No paid provider is used |
| **If they exist** | Record the model and version. Run 20–30 human-reviewed grounded prompts (English, Tamil, mixed, Tanglish, insufficient-evidence, adversarial), with automated scores kept separate from human review. Workspace-scoped retrieval and citations; B cannot read A's storage objects; presigned URL scope |
| **Rollback** | Unset the values in Render and redeploy |

### Day 4: UX, accessibility, operations, final decision

| | |
|---|---|
| **Prerequisite** | Days 1–3 accepted, or their gaps recorded as UNVERIFIED |
| **Action** | Fix only defects demonstrated on Days 1–3, each with a regression test, exact-head CI, redeploy and requalification. Re-run the live boundary probes and axe on the final head. Check operational behaviour: cold start, `/healthz`, `/readyz` and `/releasez` agree; flags still OFF; logs carry no secrets. Optional bounded worker/upload/MCP windows (Days 13–15 criteria) only if their dependencies exist; flags back OFF afterwards |
| **Decision** | Update `SAKTHIAI_FINAL_RELEASE_READINESS.md`: GO / CONDITIONAL GO / HOLD against preview scope, with exact remote, tested and deployed SHAs and the run, job and deploy IDs. **GO requires Days 1 and 2 accepted.** A real model is required for any claim of grounded-answer quality |

### Owner time for the four days

| Day | Owner action | Effort |
|---|---|---|
| 1 | Add 2 repo secrets; confirm the backup timestamp | ~15 min |
| 2 | Render OIDC values, redirect URI, 2 identities, browser sign-ins | ~45 min |
| 3 | Yes/no on zero-cost LLM, embeddings and storage; human review if an LLM exists | 15 min – 2 h |
| 4 | Final decision | ~15 min |

## Days 1–2: preview database (highest priority)

| Step | Who | Acceptance evidence |
|---|---|---|
| **Add repo secrets `SAKTHIAI_PREVIEW_DATABASE_URL` and `AIVEN_MYSQL_CA_CERT_B64`** (inspect run `37250477782` showed both missing) | [OWNER] | A re-run of inspect gets past "Require preview database secrets" |
| Dispatch "SakthiAI Preview DB Setup" in `mode=inspect` with the provider-listed recovery point | Claude | Run ID. Steps "Require preview database secrets" and "Validate isolated Aiven MySQL target" pass. `pre` is PASS, with an applied/pending journal list matching the expected baseline, `rowsNewerThanRecoveryPoint = {}`, and a `preview-migration-pre.json` artifact |
| Recovery point: provider-listed `2026-10-05T00:28:42.354867Z` (owner-checked); take a newer backup if anything writes to the DB first | [OWNER] | Aiven backup timestamp (UTC with Z), quoted verbatim |
| Dispatch `mode=migrate` with the same recovery point, **once** | Claude | Run ID. Pre/post/rerun guards PASS; pending migrations applied in order (0000–0010 if the DB is empty, as live `/readyz` suggests; `pending=none` if already applied); backfill reports N (0 on an empty DB), then `updated=0`; evidence artifact |
| Post-migration readiness | Claude | `/readyz` shows `database: configured` and `databaseSchema.status: current` (from `77de9f7`; before the migration it shows `schema_mismatch`); `/releasez` matches the deployed head; no new error logs |

**Stop conditions:**
- Missing secret, wrong DB name, or a journal hash/order mismatch.
- Rows newer than the recovery point.
- Any guard FAIL. Never re-run `migrate` after a partial failure without a new recovery point.
- Restore drill: restore into a **new** Aiven database only if the free plan allows it at $0 [OWNER]. Otherwise mark the restore as UNTESTED.

## Days 1–3: OIDC configuration [OWNER]

1. **Owner enters these in the Render dashboard** (environment for `sakthiai-hitech-preview`):
   - Runtime: `JWT_SECRET`, `OIDC_AUTHORIZATION_URL`, `OIDC_TOKEN_URL`, `OIDC_USERINFO_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URI=https://sakthiai-hitech-preview.onrender.com/api/oauth/callback`, `OIDC_SCOPES`.
   - **Build-time:** `VITE_OIDC_AUTHORIZATION_URL` and `VITE_OIDC_CLIENT_ID`.
2. Register the redirect URI with the identity provider.
3. Create two disposable test identities (A and B) and share them out of band, never in chat logs committed to Git.
4. Claude redeploys the CI-verified head, because the VITE values are baked in at build time.
   - **Acceptance:** `/readyz` shows `authentication: configured`, and the landing sign-in reaches the provider (not the "not configured" alert).

## Days 4–6: authenticated core (mandatory for any GO)

| Capability | Acceptance evidence (live preview) |
|---|---|
| Login with PKCE and state, safe `returnTo` | A logs in; `app_session_id` is HttpOnly and SameSite=Lax; hostile `returnTo` stays on origin |
| Logout, mobile logout, revoke-all, replay rejection | A replayed old cookie gets 401 after logout/revoke-all; a newer login revokes the older session |
| Two-user workspace isolation | B gets 403/404 on A's `workspaceId` for workspace, project, document, chat, task and MCP procedures |
| Storage authorization | B cannot read A's `/api/storage/*` object (requires storage) |
| Error states | Disabled upload and model-unavailable messages are truthful on mobile and desktop |
| Accessibility | axe shows 0 serious/critical on the authenticated workspace at 390 and 1440 px |

**Stop condition:** any cross-tenant read or write, or a replayed session that is accepted. That is a release blocker: fix it, run exact-head CI, redeploy and requalify.

## Days 7–9: documents, retrieval and grounding

1. Use the existing text ingestion path (uploads stay OFF), with disposable fixtures in English, Tamil, mixed and Tanglish.
2. **Acceptance:**
   - Retrieval returns workspace-scoped chunks only.
   - Citations reference the source document.
   - Insufficient evidence produces the grounded refusal state.
   - Cross-script queries are recorded with lexical fallback. Disclose the semantic gap without embeddings.
3. If no LLM is configured, `chat.send` returns MODEL_UNAVAILABLE truthfully. That is verifiable even without a model.

## Days 3 and 10–12: model and storage [OWNER]

1. **Owner confirms** whether a zero-cost self-hosted, OpenAI-compatible LLM endpoint reachable from Render exists (`LOCAL_LLM_API_URL`, `LOCAL_LLM_MODEL`), and the same for embeddings (`LOCAL_EMBEDDING_*`) and S3-compatible storage (`STORAGE_*`).
2. **If an LLM exists:**
   - Record the model and version.
   - Run 20–30 human-reviewed grounded prompts across English, Tamil, mixed and Tanglish, including insufficient-evidence and adversarial cases.
   - Keep automated scores separate from human review.
   - Verify timeout, breaker and fallback, plus budget persistence (`GATEWAY_STATE_STORE`).
3. **If none exists:** the capability stays **UNVERIFIED**. Never switch to a paid provider [OWNER-PAID].
4. **Storage:** verify ownership and presigned URL scope.

## Days 13–15: controlled worker, uploads and MCP (only if dependencies exist)

1. **Worker:** set `TASK_WORKER_ENABLED=true` for a bounded window.
   - **Acceptance:** `chat.sendAsync` claim, lease, renewal, graceful shutdown and abandoned recovery behave as specified, with the idempotency key honoured. Then restore the flag to OFF.
2. **Uploads:** only with real storage **and** a reachable ClamAV.
   - **Acceptance:** a clean file finalizes; EICAR is rejected and purged; scanner-down fails closed; another user's upload ID is refused; cleanup runs. Then flags OFF.
   - Without ClamAV, uploads stay disabled and UNVERIFIED.
3. **MCP:** only with an owner-approved read-only endpoint.
   - **Acceptance:** mutation tools are never offered or callable; an endpoint override is refused; timeouts and redaction work.

## Days 16–18: release-blocking UX and final readiness

1. Fix only defects demonstrated during Days 4–15, each with a regression test, exact-head CI, redeploy and requalification.
2. Re-run the live boundary probes and the axe scan once on the final head.
3. Update `SAKTHIAI_FINAL_RELEASE_READINESS.md`:
   - GO / CONDITIONAL GO / HOLD against the preview scope.
   - Exact remote, tested and deployed SHAs.
   - Run, job and deploy IDs.
   - Per-capability evidence levels.

## Days 19–20: authorized release preparation [OWNER]

1. Owner decision on PR #29: mark ready for review and merge to `main`. This needs explicit owner approval, a green exact-head CI and a passing Protected Main Gate.
2. A production deployment plan, if requested, is a separate approval with its own recovery point and rollback target.

## Owner involvement estimate

| Item | Effort |
|---|---|
| Aiven backup confirmation | ~10 min |
| Render OIDC entry, provider registration and 2 test identities | ~30–45 min |
| LLM/storage/ClamAV availability answers | ~15 min |
| Human review of model answers | ~1–2 h |
| Final release decision | ~15 min |
