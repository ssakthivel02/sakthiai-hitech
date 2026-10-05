# SakthiAI HI-TECH: 20-day continuation plan (PR #29 preview release)

Start date: 5 October 2026. Planned work only: **nothing here is complete until its acceptance evidence exists.**

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

## Days 1–2: preview database (highest priority)

| Step | Who | Acceptance evidence |
|---|---|---|
| Dispatch "SakthiAI Preview DB Setup" in `mode=inspect` with the provider-listed recovery point | Claude | Run ID. Steps "Require preview database secrets" and "Validate isolated Aiven MySQL target" pass. `pre` is PASS, with an applied/pending journal list matching the expected baseline, `rowsNewerThanRecoveryPoint = {}`, and a `preview-migration-pre.json` artifact |
| Confirm a provider backup newer than any write since power-on | [OWNER] | Aiven backup timestamp (UTC with Z), quoted verbatim |
| Dispatch `mode=migrate` with the same recovery point, **once** | Claude | Run ID. Pre/post/rerun guards PASS; migrations 0005–0010 applied in order (or `pending=none` if already applied); backfill reports N, then `updated=0`; evidence artifact |
| Post-migration readiness | Claude | `/readyz` shows `database: configured`; `/releasez` matches the deployed head; no new error logs |

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
