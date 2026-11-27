# SakthiAI Core Runtime Security Acceptance

Status: **HARNESS SOURCE IMPLEMENTED / LIVE EXECUTION NOT YET AUTHORISED OR PROVEN**

Harness: `scripts/core-runtime-security-acceptance.ts`

## Purpose

This harness proves the remaining core external-beta security gates against one exact deployed SakthiAI candidate without invoking paid model/media generation.

It covers:

1. `/healthz` availability;
2. exact `/releasez` commit identity;
3. `/readyz` HTTP 200;
4. two distinct authenticated non-admin test identities;
5. bidirectional cross-tenant project/file access denial;
6. adversarial conversation-ID replay denial;
7. malware clean-file acceptance;
8. EICAR malware detection and non-persistence;
9. scanner-unavailable fail-closed behavior in a separate negative pass;
10. server-side revoke-all and rejection of the previously valid token.

## Critical integration boundary

Do **not** run this harness against the current PR #7 head and claim it proves PR #25 security controls.

PR #7 currently owns the Creator/runtime lane and its exact deployed-candidate process. PR #25 contains the new session-revocation and malware-gate source. Until an explicitly approved integration candidate contains both required runtime work and the PR #25 P0 source controls, live execution cannot prove the combined release gate.

Do not solve this by creating a second preview service, force-pushing, or silently merging branches. Reconcile integration authority first.

## Safety constraints

The harness itself:

- does not deploy;
- does not migrate a database;
- does not alter Render/Aiven/DNS;
- does not invoke LLM/image/video generation;
- does not print session tokens;
- does not print provider secrets;
- refuses to use an admin account as revocation test user A;
- requires explicit opt-in before file-write probes;
- requires explicit opt-in before revoking test user A's sessions.

Use dedicated disposable **non-admin** preview test users. Never use the owner/admin session token for `SAKTHIAI_USER_A_TOKEN`.

## Secure runtime inputs

Set these only in the approved operator shell/secret environment. Do not paste values into GitHub comments or chat transcripts.

Required:

- `SAKTHIAI_BASE_URL`
- `SAKTHIAI_EXPECTED_SHA`
- `SAKTHIAI_USER_A_TOKEN`
- `SAKTHIAI_USER_B_TOKEN`

Recommended explicit tenant evidence:

- `SAKTHIAI_USER_A_WORKSPACE_ID`
- `SAKTHIAI_USER_B_WORKSPACE_ID`
- `SAKTHIAI_USER_A_CONVERSATION_ID`
- `SAKTHIAI_USER_B_CONVERSATION_ID`

File-security acceptance additionally requires:

- `SAKTHIAI_ACCEPTANCE_WORKSPACE_ID` — an isolated workspace owned by test user A;
- `SAKTHIAI_ALLOW_ACCEPTANCE_WRITES=true`.

Revocation proof additionally requires:

- `SAKTHIAI_ALLOW_REVOCATION=true`.

## Pass A — scanner available

With approved ClamAV reachable and `SAKTHIAI_SCANNER_MODE=available`:

```bash
SAKTHIAI_SCANNER_MODE=available \
pnpm exec tsx scripts/core-runtime-security-acceptance.ts
```

A complete pass requires:

- exact deployed SHA matches `SAKTHIAI_EXPECTED_SHA`;
- readiness is HTTP 200;
- user A and user B are distinct;
- both users are denied access to the other's workspace resources;
- supplied cross-tenant conversation IDs cannot be replayed;
- a unique known-clean text fixture is accepted;
- an EICAR fixture is rejected with malware-quarantine behavior;
- the EICAR filename is absent from normal document persistence;
- revoke-all returns HTTP 204 for user A;
- reusing the same revoked token returns HTTP 401.

The clean fixture intentionally creates one bounded document in the isolated acceptance workspace. Do not use a production/user-content workspace.

## Pass B — scanner unavailable

This is a separate controlled negative test. The runtime owner must deliberately make the scanner unavailable through the approved runtime procedure; the harness does not alter infrastructure itself.

Set:

```bash
SAKTHIAI_SCANNER_MODE=unavailable
```

and run the same harness with a fresh disposable user-A token if the previous available-mode run revoked it.

Required evidence:

- upload returns scanner-unavailable rejection;
- the unscanned filename is absent from normal document persistence;
- the application does not fail open.

Restore the approved scanner configuration through the runtime-owner procedure, then reconfirm `/readyz` and a clean upload before retaining the candidate.

## Conversation replay requirement

For a full P0 tenant-isolation result, provide a real existing conversation ID from each test tenant. The harness intentionally does not create conversations because `chat.send` may invoke a configured LLM and could introduce provider usage/cost.

If either conversation ID is missing, the corresponding replay check fails and the overall result remains `BLOCKED_OR_FAILED`.

## Evidence handling

The harness prints only pass/fail identifiers, non-secret IDs needed for traceability, and a redacted summary. Redirect stdout to the approved evidence location if required by the release process.

Do not store:

- session JWT values;
- OIDC access tokens;
- provider API keys;
- database passwords;
- ClamAV/network credentials.

## Required ordering with PR #7 runtime qualification

Before any live run:

1. fresh-reconcile `main`, PR #7, PR #25 and Issue #1;
2. identify the single approved integration/deployment candidate;
3. confirm no other ChatGPT/agent is modifying the runtime lane;
4. preserve `autoDeploy=OFF`;
5. follow PR #7's DB/TLS/recovery/migration/runtime sequence for the approved candidate;
6. verify exact `/releasez` SHA;
7. require `/readyz` HTTP 200;
8. execute this core security harness using dedicated test identities;
9. execute Creator runtime acceptance without paid generation;
10. stop before any paid provider call unless the owner separately approves spend.

## Release classification

Green source/CI for this harness is **not** live evidence.

Only after both scanner modes, session revocation, two-tenant replay, exact SHA/readiness and the existing runtime/DB gates have produced evidence may these controls be reclassified from:

`SOURCE_IMPLEMENTED / RUNTIME_UNVERIFIED`

to:

`RUNTIME_VERIFIED`

This document does not authorise merge, external beta, production, DNS promotion or provider spend.
