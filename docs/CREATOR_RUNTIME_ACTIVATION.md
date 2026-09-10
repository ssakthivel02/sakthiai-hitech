# SakthiAI Creator — Runtime Activation Gate

This runbook activates the first real Murugan Creator acceptance test without committing or exposing runtime secrets.

## Preconditions

Use only a PR #7 candidate whose exact head SHA is unchanged and whose Quality Gate, Parallel Work Guard, and Protected Main Gate workflows are green.

Do not proceed if another ChatGPT/Codex task is modifying `feature/creator-mvp`.

## Runtime dependencies

The Creator preflight must validate all required dependencies before any paid generation request is allowed:

- `DATABASE_URL`
- `STORAGE_BUCKET`
- S3-compatible storage endpoint/region where required
- storage credentials or approved ambient credentials
- `GEMINI_API_KEY`
- Google Veo API/model configuration
- FFmpeg available to the render worker

Configure secrets only in the approved runtime/deployment secret manager. Never commit live values to Git, `.env`, PR comments, issues, workflow logs, screenshots, or ChatGPT messages.

## Activation sequence

1. Deploy or run the exact PR #7 candidate SHA.
2. Apply the Creator database migration in that runtime.
3. Configure the database and storage environment.
4. Configure the authorised Google/Veo credential and model settings.
5. Confirm FFmpeg is present in the render runtime.
6. Authenticate to a SakthiAI workspace.
7. Open `/creator/runtime`.
8. Refresh preflight.
9. Require PASS for database, storage, image provider, video provider, and FFmpeg.
10. Require `readyForPaidGeneration=true`.
11. Keep `productionApproved=false`; runtime readiness is not release approval.

If any required check fails, stop before paid provider submission.

## Storage acceptance before paid generation

Before spending provider credits, verify the deployed runtime can:

- connect to the configured bucket;
- write an acceptance object;
- read it back;
- verify the bytes/hash match;
- delete the acceptance object if policy permits;
- persist Creator artifact metadata in the configured database.

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

1. runtime preflight PASS;
2. real provider request completes;
3. output is persisted and can be reloaded;
4. provenance/checksum exists;
5. approved visual assets cover the required timeline;
6. Tamil captions are locked to the approved audio;
7. deterministic 16:9 candidate render completes;
8. SakthiAI quality review passes;
9. cross-shot seam review passes;
10. genuine human Tamil PASS;
11. genuine human visual PASS;
12. exact-head CI remains green after any remediation.

Only then may the candidate be promoted to an approved final master. This still does not by itself authorize production release or automated publication.

## Stop conditions

Stop immediately if:

- PR #7 head changes during the acceptance run;
- another agent starts modifying the same Creator lane;
- exact-head CI fails;
- a secret appears in source, logs, screenshots, or chat;
- provider spend cannot be bounded;
- database/storage write-read acceptance fails;
- persisted artifact provenance is absent;
- the approved audio identity is uncertain;
- human review has not actually inspected the final output.

## Current claim boundary

Until the first real acceptance evidence exists, do not claim that SakthiAI has replaced Runway, is production-ready, has generated a passed Murugan film sequence, is cheaper than another provider, or has achieved final Tamil/visual quality approval.
