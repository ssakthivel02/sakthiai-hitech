# SakthiAI — Combined Integration Runtime Qualification

Status: **SOURCE + CI QUALIFIED CANDIDATE / LIVE RUNTIME UNPROVEN**

> **CURRENT RELEASE AUTHORITY — 24 Nov 2026:** Draft [PR #63](https://github.com/ssakthivel02/sakthiai-hitech/pull/63) is the existing consolidated Web/Creator candidate. Earlier PR #29 was an integration input and is **not** a deploy or database-migration target. The current PR #63 commit must be explicitly approved and exact-head CI-qualified; a prior green SHA is not enough.
>
> **HARD STOP (migration journal):** Current PR #63 records `0021_creator_provider_job_uniqueness`, whereas independently owned Sentinel [PR #34](https://github.com/ssakthivel02/sakthiai-hitech/pull/34) records a different `0021_sentinel_investigations` at the same journal timestamp. No source merge, SQL replay or migration dispatch resolves this automatically. Verify the *actual applied* `__drizzle_migrations` sequence, preserve applied hashes, and obtain a reviewed forward-only additive reconciliation before any `mode=migrate`. Do not silently rename an already applied migration or take ownership of Codex's Sentinel PR.
>
> **HARD STOP (shared MySQL):** The existing free Aiven MySQL service is POWEROFF and serves multiple projects. Its configured `0.0.0.0/0` and `::/0` ingress must be restricted **before any power-on** under separate network/security authorization. Follow existing [preservation PR #48](https://github.com/ssakthivel02/sakthiai-hitech/pull/48) / [issue #46](https://github.com/ssakthivel02/sakthiai-hitech/issues/46); do not presume provider snapshots are portable or restore-tested. No power-on, plan change, paid service, network rule change, export, migration or Render deployment is authorised by this document or a general “continue” request.

This runbook is the integration-level coordinator for the single combined Creator + Core candidate in PR #63. It does not replace the detailed Creator or Core security runbooks; it defines the order and evidence boundary when both must be proven on one deployed SHA.

## Authority

Use only PR #63 (`qualification/creator-vertical-maintenance-combined-20261112`) as the combined qualification candidate while that PR remains the active integration surface.

Do **not** deploy standalone PR #7 and claim Core security acceptance. Do **not** deploy standalone PR #25 and claim Creator runtime acceptance. Do not create another integration branch or preview service while PR #63 is active.

Before every GitHub or infrastructure write, re-read:

1. protected canonical `main` and existing PR #63 branch head;
2. PR #63 exact-head CI, Draft/review status and authorized writer;
3. Creator-owner PR #58 and already integrated Creator deltas, without duplicate writes;
4. Sentinel-owner PR #34 applied-migration conflict, read-only unless Codex explicitly hands off;
5. Issues #1, #46 and #50 for launch, shared-data preservation and render idempotency gates;
6. existing suspended Render preview state (auto-deploy OFF);
7. shared Aiven service's network and backup authorization state (no mutation without approval).

If PR #63 moves during runtime qualification, stop and restart exact-SHA evidence collection. If Creator PR #58 or Sentinel PR #34 moves, do not silently refresh or rebuild PR #63; reconcile ownership, source overlap and the two different migration histories first.

## Current source boundaries

- Creator/runtime details: `docs/CREATOR_RUNTIME_ACTIVATION.md`.
- Core live security acceptance: `docs/CORE_RUNTIME_SECURITY_ACCEPTANCE.md`.
- File malware gate: `docs/FILE_MALWARE_GATE.md`.
- Canonical launch control: Issue #1.

Where the Creator runbook refers to deploying a PR #7 candidate, that instruction is superseded for combined qualification: deploy only the current explicitly approved PR #63 exact head.

## Liveness vs readiness

Render's platform health check intentionally uses `/healthz`.

- `/healthz` proves only that the process is alive.
- `/readyz` is the controlled acceptance gate for database/auth/LLM/storage readiness.
- `/releasez` proves deployed repository/commit identity.

A Render service showing healthy is therefore **not** runtime acceptance. PR #63 qualification requires all three endpoints, with `/releasez` matching the exact approved PR #63 SHA and `/readyz` returning HTTP 200.

Scanner status in `/readyz` is informational while file ingestion remains `Coming Soon`:

- configuration may be `configured_unverified`, `not_configured`, or `invalid_configuration`;
- `liveProbe=not_checked` must not be interpreted as scanner availability;
- scanner does not gate global readiness while upload/document ingestion is disabled;
- the file-ingestion path itself remains fail closed.

## Zero-spend runtime posture

The controlled qualification may prove infrastructure, auth, tenant isolation, chat, storage, database and Creator data-plane readiness without making any paid media/model request.

Do not:

- create a second Render service;
- create a second Aiven service/database;
- enable Render auto-deploy;
- provision paid scanner compute merely to expose uploads;
- call paid image/video/model APIs;
- generate media credits usage;
- change DNS;
- expose or paste runtime secrets.

File ingestion stays disabled for external beta until a real scanner runtime has separate live evidence and explicit owner approval.

## Qualification sequence

### Gate 0 — freeze the candidate

1. Re-read PR #63 and record its exact head SHA.
2. Require every exact-head PR #63 workflow to be green.
3. Confirm PR #63 remains DRAFT and unmerged.
4. Confirm no other ChatGPT/agent is changing PR #63 or the runtime infrastructure lane.

### Gate 1 — inspect existing Render only

1. Use only the existing `sakthiai-hitech-preview` service.
2. Confirm the correct Render workspace with the owner before connector inspection.
3. Confirm `autoDeploy=OFF`.
4. Inspect configuration presence only; never reveal secret values.
5. Confirm Node 22, `pnpm@10.4.1` (build only), start command `exec node dist/index.js`, `DATABASE_EXPECTED_NAME=sakthiai_preview`, verified DB CA configuration, OIDC, LLM and storage prerequisites.
6. Confirm no duplicate preview service was created.

STOP if the deployed service identity, ownership, auto-deploy state or secret-management path is uncertain.

### Gate 2 — controlled Aiven access and shared-data preservation (separate owner approval)

1. **STOP before any power-on** unless the owner/security reviewer separately authorizes the exact network restriction, power-on window, cost boundary and scoped read-only export identity. A general continuation request is not this authorization.
2. Because the powered-off service's published configuration includes `0.0.0.0/0` and `::/0`, restrict ingress to approved operator source(s) or private access **before power-on**. Record the change privately and keep verified TLS/CA and least privilege. Do not quietly change Aiven network rules or billing.
3. Under the approved window, start **only the existing** `hitech-preview-mysql` and confirm `RUNNING`. Identify the four pre-existing schemas: `sakthiai_preview`, `kirthiverse_preview`, `ramaverse_preview`, and `defaultdb` (unknown contents; do not presume disposable). Never create a second service or export another project's contents without its owner's authority.
4. Privately record current source MySQL version, region, each schema owner, verified TLS, migration-journal identity, hosting snapshot timestamps, and any writes later than the most recent backup. Provider-managed snapshots are not downloadable or independent restore proof.
5. Obtain authorized **encrypted off-service export** for each retained schema using compatible tools and an approved private storage destination; validate hashes, separately referenced media/object storage and an **isolated scratch restore** with schema, row counts, Tamil/UTF-8 samples and applied-migration history. Follow the existing [PR #48 runbook](https://github.com/ssakthivel02/sakthiai-hitech/pull/48), not a second backup flow.
6. Read-only Gate 3 inspection may occur during an approved secure access window, but **Gate 4 migration and any deployment remain STOPPED** until an independently restorable recovery copy, journal reconciliation, and separate explicit write approval exist. Keep the old service and hosted snapshots unchanged.

### Gate 3 — guarded read-only database inspect

1. Freeze and record the exact approved PR #63 SHA.
2. Dispatch **SakthiAI Preview DB Setup** from that exact PR #63 ref with `mode=inspect`, `approved_commit=<exact SHA>`, and the fresh recovery point.
3. Require the bind job to prove `approved_commit == github.sha`.
4. Require the inspect environment's SELECT-only principal, verified TLS, exact `sakthiai_preview` target, journal/hash prefix validation, schema classification, and recovery-point checks to PASS.
5. Review the uploaded migration evidence before authorizing any write.

STOP if inspect reports journal/hash drift, orphan/partial migration objects, rows newer than the recovery point, wrong privileges, wrong database, unverified TLS, or any SHA mismatch.

### Gate 4 — separately approve and apply reviewed migrations

This gate is a **separate write authorization** from inspect.

**Additional fail-closed precondition:** exact applied journal identity must be independently inspected and the PR #63 / Sentinel PR #34 `0021` collision must have a reviewed forward-only reconciliation plan. Require the encrypted off-service export and isolated scratch restore from Gate 2 first. No renumbering, destructive migration or replay against the shared source to “try it.”

1. Re-read PR #63 and require the exact inspected SHA to remain current and fully green.
2. Reconfirm the same fresh recovery evidence remains valid.
3. Dispatch the guarded workflow with `mode=migrate`, the same exact `approved_commit`, and approved recovery point.
4. Require only the reviewed migration journal to be applied; do not generate migrations on the runtime host.
5. Require post-migration preservation checks, a no-op migrator rerun, and search-text backfill idempotency to PASS.
6. Require the migration evidence to show the full repository journal applied, including `0013_rate_limit_windows`.

STOP if PR #63 moves between inspect and migrate; restart from Gate 0 and re-inspect the new exact SHA.

### Gate 5 — exact-commit deployment and readiness proof

Only after Gate 4 is green:

1. Deploy only the same frozen PR #63 exact SHA through the existing `sakthiai-hitech-preview` Render service.
2. Do not deploy a branch tip such as `latest` without recording the exact commit.
3. Request `/releasez`; require the exact approved PR #63 SHA and verified artifact identity.
4. Request `/healthz`; require HTTP 200 / `alive`.
5. Request `/readyz`; require HTTP 200 / `ready`.
6. Verify readiness proves the current database schema, auth configuration, eligible LLM route, storage posture, MySQL-backed rate-limit store and intact artifact.

**Why migration precedes readiness:** the application deliberately returns `/readyz` 503 with `database=schema_mismatch` when the database is behind the build. Therefore deployment/readiness acceptance must never be used as a prerequisite for the migration that makes the schema current.

STOP on any SHA, artifact, schema or readiness mismatch.

### Gate 6 — non-paid Creator acceptance

1. Run `pnpm creator:runtime:acceptance` against the exact deployed SHA.
2. Require schema probe and storage/data-plane checks appropriate to the enabled beta posture.
3. Authenticate to an approved workspace and open `/creator/runtime`.
4. Run the non-paid runtime/data-plane verification and require `VERIFIED`.
5. Do not enable paid image/video generation.

### Gate 7 — Core live security acceptance

Use two fresh disposable non-admin identities created/logged in **after** the PR #63 deployment so their session cookies contain the current generation/JTI format.

Run the Core runtime security acceptance against the exact same PR #63 SHA and require:

1. exact `/releasez` match;
2. `/readyz` PASS;
3. bidirectional cross-tenant project/file denial;
4. conversation-ID replay denial;
5. server-side revoke-all invalidates reuse of the revoked token.

Because file ingestion is currently disabled, do not claim live clean/EICAR scanner acceptance unless a separately approved live scanner runtime has been provisioned and proven. The source-level fail-closed malware gate remains required regardless.

### Gate 8 — browser/human acceptance

Before any external beta claim, verify on the exact deployed PR #63 SHA:

- login/logout and revoked-session behavior;
- tenant/workspace navigation and denial behavior;
- responsive/mobile layout for exposed features;
- keyboard/focus behavior;
- screen-reader semantics appropriate to the exposed flow;
- privacy/security copy and capability labels;
- Creator runtime UI structural/data-plane status;
- file-ingestion UI remains disabled/Coming Soon when scanner runtime is unproven.

## Paid-provider stop gate

Completing Gates 0–8 does **not** authorize a paid media/model request.

A first Gemini/Veo/image/video generation test requires a separate explicit owner approval defining a bounded spend/test scope. Until then, stop after non-paid Creator/runtime/security qualification.

## Evidence record

Record only non-secret evidence:

- exact PR #63 SHA;
- PR #63 exact-head CI runs;
- Render service identity and auto-deploy state;
- `/releasez`, `/healthz`, `/readyz` results;
- Aiven service/database/TLS/recovery evidence;
- migration command/result against `sakthiai_preview`;
- Creator runtime acceptance result;
- authenticated `/creator/runtime` verification result;
- disposable identity IDs/labels without credentials;
- tenant/adversarial replay acceptance result;
- revoke-all acceptance result;
- browser/human QA findings;
- capability labels confirming file ingestion remains disabled when scanner is unproven.

Never store credentials, cookies, access tokens, refresh tokens, private keys or secret values in GitHub evidence.

## Stop conditions

Stop immediately if:

- PR #63 head changes during qualification;
- another agent begins changing the same integration/runtime lane;
- exact-head CI is not fully green;
- Render workspace/service identity is uncertain;
- `autoDeploy` is enabled unexpectedly;
- `/releasez` does not match the approved PR #63 SHA;
- `/readyz` is not 200/ready;
- Aiven target is not exactly `sakthiai_preview`;
- verified TLS or recovery evidence is missing;
- migration scope is uncertain;
- tenant/revocation acceptance fails;
- a secret appears in source/logs/chat/screenshots;
- a paid provider call would occur without explicit approval.

## Claim boundary

A green PR #63 proves source/integration compatibility only. A successful non-paid runtime qualification proves the combined runtime controls exercised by the acceptance sequence. Neither by itself authorizes merge, external beta for disabled capabilities, production, DNS promotion, paid provider use or publication.
