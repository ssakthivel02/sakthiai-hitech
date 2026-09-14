# SakthiAI Creator — Runtime Activation Gate

This runbook activates the first real Murugan Creator acceptance test without committing or exposing runtime secrets.

## Preconditions

Use only a PR #7 candidate whose exact head SHA is unchanged and whose Quality Gate, Parallel Work Guard, and Protected Main Gate workflows are green.

Do not proceed if another ChatGPT/Codex task is modifying `feature/creator-mvp`.

Before every runtime or infrastructure write, re-check the exact PR head, current `main`, open PRs, recent coordination comments, CI, and the existing preview runtime. Stop and reconcile if another task has advanced the same lane.

## Runtime dependencies

The Creator runtime must have all required dependencies configured before any paid generation request is allowed:

- `JWT_SECRET`;
- `DATABASE_URL` targeting only `sakthiai_preview`;
- `DATABASE_EXPECTED_NAME=sakthiai_preview`;
- `DATABASE_CA_CERT_B64` for verified Aiven TLS;
- provider-neutral OIDC frontend/backend values required by `/readyz`;
- provider-neutral LLM URL/model required by `/readyz`;
- `STORAGE_BUCKET`;
- S3-compatible storage endpoint/region where required;
- storage credentials or approved ambient credentials;
- `GEMINI_API_KEY`;
- `GOOGLE_VEO_API_BASE` / approved Google Veo API configuration;
- FFmpeg available to the render worker.

Configure secrets only in the approved runtime/deployment secret manager. Never commit live values to Git, `.env`, PR comments, issues, workflow logs, screenshots, or ChatGPT messages.

The existing Render Blueprint is the approved preview path. Keep automatic deployment OFF. Inspect and reuse the existing `sakthiai-hitech-preview` service rather than creating a parallel runtime.

## Activation sequence

1. Fresh-check PR #7, current `main`, open PRs, recent coordination comments, exact-head CI, Aiven state, and existing Render state.
2. Inspect the existing `sakthiai-hitech-preview` Render service and verify the required runtime environment listed above without exposing secret values.
3. Confirm Render automatic deployment remains OFF.
4. Immediately before runtime qualification, power on the existing Aiven `hitech-preview-mysql` service. Require state `RUNNING`, reconfirm that `sakthiai_preview` exists, and do not change the current IP filter blindly before approved Render egress is known.
5. Deploy only the exact approved PR #7 candidate SHA using Render's exact-commit deployment path.
6. Request `/releasez` and require it to report that exact deployed SHA. If the SHA is unknown or different, STOP.
7. Request `/readyz` and require HTTP 200 / `status: ready`. This gate proves the deployed application can establish its basic database/authentication/LLM/storage runtime configuration. If `/readyz` is 503, fix configuration before migration; do not weaken the gate.
8. Confirm the database connection targets only `sakthiai_preview` and uses the Aiven CA with verified TLS.
9. Run `pnpm db:push`. This command is apply-only (`drizzle-kit migrate`) and must apply the reviewed migration set; do not generate migration artifacts on the preview host.
10. Run `pnpm creator:runtime:acceptance` and require every required check PASS. This performs the Creator schema probe plus a tiny SakthiAI-owned storage write/read canary with best-effort cleanup; it does not call Gemini or Veo.
11. Authenticate to an authorised SakthiAI workspace and open the `/creator/runtime` browser route.
12. Refresh the structural preflight and require PASS for database, storage, image provider, video provider, and FFmpeg.
13. Select **Verify data plane** and require the authenticated view to show **VERIFIED** / `readyForPaidGeneration=true`.
14. Keep `productionApproved=false`; runtime readiness is not production, publishing, or spend approval.
15. STOP before any paid image/video generation unless explicit owner approval for a bounded provider-spend test is present.

If any required check fails, stop before paid provider submission.

### Important route semantics

`/releasez` and `/readyz` are public operational JSON endpoints used for deployment identity and readiness checks.

`/creator/runtime` is an authenticated browser UI route, not a public JSON health endpoint. Its structural and live verification data come from protected tRPC procedures (`creator.preflight` and `creator.verifyRuntime`) scoped to an authorised SakthiAI workspace.

## Storage acceptance before paid generation

Before spending provider credits, verify the deployed runtime can:

- connect to the configured bucket;
- write a SakthiAI-owned acceptance canary;
- read it back;
- verify the returned bytes match;
- delete the acceptance object on a best-effort basis;
- query the complete approved Creator P0 schema in `sakthiai_preview`.

Do not use a real generated asset as the first storage connectivity test.

## First paid-provider acceptance

The first test is intentionally bounded:

- 20–40 seconds total target sequence;
- 4–6 shots maximum;
- 16:9 output;
- one approved Murugan audio excerpt;
- immutable approved reference intent;
- Tamil captions checked against the approved audio;
- no automatic YouTube publication.

Generate the minimum image/reference material required first. Do not submit the full sequence until a first provider call proves successful and the resulting artifact is persisted with provenance.

## Evidence to record for every provider call

Record only non-secret evidence:

- exact SakthiAI commit SHA;
- Creator project/scene/shot ID;
- provider and model;
- provider job/request ID;
- submission timestamp;
- completion timestamp;
- requested duration/resolution/aspect ratio;
- output Creator asset ID;
- output SHA-256/provenance record;
- elapsed generation time;
- actual or provider-reported cost where available;
- accepted/rejected decision and reason.

Never record the credential itself.

## Murugan visual acceptance

A shot is not accepted merely because the provider returned a video. Human review must reject material defects including:

- Murugan identity drift;
- malformed face, hands, limbs, or body;
- incorrect or changing Vel;
- inconsistent crown, jewellery, costume, or sacred iconography;
- unintended duplicated people/body parts;
- peacock anatomy defects that materially reduce quality;
- unintended text, logo, watermark, or provider branding;
- severe lighting/environment discontinuity;
- visible black/frozen/missing frames.

Cross-shot seam review must also pass before final assembly acceptance.

## Audio and Tamil acceptance

Use only the approved immutable audio master. Verify every Tamil caption against the heard audio and final rendered video. Reject missing, duplicated, corrupted, early, or late cues.

## Final acceptance chain

A real Creator acceptance sequence requires all of the following evidence:

1. exact deployed SHA proven by `/releasez`;
2. `/readyz` PASS;
3. reviewed Creator migration applied only to `sakthiai_preview`;
4. CLI Creator runtime acceptance PASS;
5. authenticated `/creator/runtime` live data-plane verification PASS;
6. real provider request completes;
7. output is persisted and can be reloaded;
8. provenance/checksum exists;
9. approved visual assets cover the required timeline;
10. Tamil captions are locked to the approved audio;
11. deterministic 16:9 candidate render completes;
12. SakthiAI quality review passes;
13. cross-shot seam review passes;
14. genuine human Tamil PASS;
15. genuine human visual PASS;
16. exact-head CI remains green after any remediation.

Only then may the candidate be promoted to an approved final master. This still does not by itself authorize production release or automated publication.

## Stop conditions

Stop immediately if:

- PR #7 head changes during the acceptance run;
- another agent starts modifying the same Creator lane;
- exact-head CI fails;
- `/releasez` does not identify the approved exact SHA;
- `/readyz` does not pass;
- a secret appears in source, logs, screenshots, or chat;
- provider spend cannot be bounded;
- database/schema or storage write-read acceptance fails;
- the database target is not exactly `sakthiai_preview`;
- verified Aiven TLS is not in use;
- persisted artifact provenance is absent;
- the approved audio identity is uncertain;
- human review has not actually inspected the final output.

## Current claim boundary

Until the first real acceptance evidence exists, do not claim that SakthiAI has replaced Runway, is production-ready, has generated a passed Murugan film sequence, is cheaper than another provider, or has achieved final Tamil/visual quality approval.
