# SakthiAI — Combined Integration Runtime Qualification

Status: **SOURCE + CI QUALIFIED CANDIDATE / LIVE RUNTIME UNPROVEN**

This runbook is the integration-level coordinator for the single combined Creator + Core candidate in PR #29. It does not replace the detailed Creator or Core security runbooks; it defines the order and evidence boundary when both must be proven on one deployed SHA.

## Authority

Use only PR #29 (`integration/pr7-pr25-runtime-qualification-20260925`) as the combined qualification candidate while that PR remains the active integration surface.

Do **not** deploy standalone PR #7 and claim Core security acceptance. Do **not** deploy standalone PR #25 and claim Creator runtime acceptance. Do not create another integration branch or preview service while PR #29 is active.

Before every GitHub or infrastructure write, re-read:

1. canonical `main`;
2. PR #29 exact head and exact-head CI;
3. PR #7 exact head;
4. PR #25 exact head;
5. Issue #1 launch-control state;
6. existing Render preview state;
7. existing Aiven preview state.

If PR #29 moves during runtime qualification, stop and restart exact-SHA evidence collection. If PR #7 or PR #25 moves after PR #29 was formed, do not silently refresh or rebuild PR #29; reconcile ownership first.

## Current source boundaries

- Creator/runtime details: `docs/CREATOR_RUNTIME_ACTIVATION.md`.
- Core live security acceptance: `docs/CORE_RUNTIME_SECURITY_ACCEPTANCE.md`.
- File malware gate: `docs/FILE_MALWARE_GATE.md`.
- Canonical launch control: Issue #1.

Where the Creator runbook refers to deploying a PR #7 candidate, that instruction is superseded for combined qualification: deploy only the current explicitly approved PR #29 exact head.

## Liveness vs readiness

Render's platform health check intentionally uses `/healthz`.

- `/healthz` proves only that the process is alive.
- `/readyz` is the controlled acceptance gate for database/auth/LLM/storage readiness.
- `/releasez` proves deployed repository/commit identity.

A Render service showing healthy is therefore **not** runtime acceptance. PR #29 qualification requires all three endpoints, with `/releasez` matching the exact approved PR #29 SHA and `/readyz` returning HTTP 200.

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

1. Re-read PR #29 and record its exact head SHA.
2. Require every exact-head PR #29 workflow to be green.
3. Confirm PR #29 remains DRAFT and unmerged.
4. Confirm no other ChatGPT/agent is changing PR #29 or the runtime infrastructure lane.

### Gate 1 — inspect existing Render only

1. Use only the existing `sakthiai-hitech-preview` service.
2. Confirm the correct Render workspace with the owner before connector inspection.
3. Confirm `autoDeploy=OFF`.
4. Inspect configuration presence only; never reveal secret values.
5. Confirm Node 22, `pnpm@10.4.1`, `pnpm start`, `DATABASE_EXPECTED_NAME=sakthiai_preview`, verified DB CA configuration, OIDC, LLM and storage prerequisites.
6. Confirm no duplicate preview service was created.

STOP if the deployed service identity, ownership, auto-deploy state or secret-management path is uncertain.

### Gate 2 — activate Aiven only immediately before qualification

1. Power on only the existing `hitech-preview-mysql` service.
2. Require state `RUNNING`.
3. Reconfirm database `sakthiai_preview` exists.
4. Verify Aiven TLS/CA expectations.
5. Capture fresh non-secret recovery evidence: service state plus latest usable backup timestamp/identifier.
6. Do not migrate if database identity or recovery evidence is uncertain.

### Gate 3 — exact-commit deployment

1. Deploy only the frozen PR #29 exact SHA through the existing Render service.
2. Do not deploy a branch tip such as `latest` without recording the exact commit.
3. Request `/releasez`; require the exact approved PR #29 SHA.
4. Request `/healthz`; require HTTP 200 / `alive`.
5. Request `/readyz`; require HTTP 200 / `ready`.
6. Verify `/readyz` proves database/auth/LLM/storage readiness and does not overclaim live scanner availability.

STOP on any SHA mismatch or readiness failure.

### Gate 4 — database migration and non-paid Creator acceptance

1. Reconfirm the target is only `sakthiai_preview`.
2. Apply only the reviewed migration set with the existing apply-only migration command.
3. Do not generate new migration artifacts on the runtime host.
4. Run `pnpm creator:runtime:acceptance`.
5. Require schema probe and storage write/read canary PASS.
6. Authenticate to an approved workspace and open `/creator/runtime`.
7. Run the non-paid runtime/data-plane verification and require `VERIFIED` before any provider spend is considered.

### Gate 5 — Core live security acceptance

Use two fresh disposable non-admin identities created/logged in **after** the PR #29 deployment so their session cookies contain the current generation/JTI format.

Run the Core runtime security acceptance against the exact same PR #29 SHA and require:

1. exact `/releasez` match;
2. `/readyz` PASS;
3. bidirectional cross-tenant project/file denial;
4. conversation-ID replay denial;
5. server-side revoke-all invalidates reuse of the revoked token.

Because file ingestion is currently disabled, do not claim live clean/EICAR scanner acceptance unless a separately approved live scanner runtime has been provisioned and proven. The source-level fail-closed malware gate remains required regardless.

### Gate 6 — browser/human acceptance

Before any external beta claim, verify on the exact deployed PR #29 SHA:

- login/logout and revoked-session behavior;
- tenant/workspace navigation and denial behavior;
- responsive/mobile layout for exposed features;
- keyboard/focus behavior;
- screen-reader semantics appropriate to the exposed flow;
- privacy/security copy and capability labels;
- Creator runtime UI structural/data-plane status;
- file-ingestion UI remains disabled/Coming Soon when scanner runtime is unproven.

## Paid-provider stop gate

Completing Gates 0–6 does **not** authorize a paid media/model request.

A first Gemini/Veo/image/video generation test requires a separate explicit owner approval defining a bounded spend/test scope. Until then, stop after non-paid Creator/runtime/security qualification.

## Evidence record

Record only non-secret evidence:

- exact PR #29 SHA;
- PR #29 exact-head CI runs;
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

- PR #29 head changes during qualification;
- another agent begins changing the same integration/runtime lane;
- exact-head CI is not fully green;
- Render workspace/service identity is uncertain;
- `autoDeploy` is enabled unexpectedly;
- `/releasez` does not match the approved PR #29 SHA;
- `/readyz` is not 200/ready;
- Aiven target is not exactly `sakthiai_preview`;
- verified TLS or recovery evidence is missing;
- migration scope is uncertain;
- tenant/revocation acceptance fails;
- a secret appears in source/logs/chat/screenshots;
- a paid provider call would occur without explicit approval.

## Claim boundary

A green PR #29 proves source/integration compatibility only. A successful non-paid runtime qualification proves the combined runtime controls exercised by the acceptance sequence. Neither by itself authorizes merge, external beta for disabled capabilities, production, DNS promotion, paid provider use or publication.
