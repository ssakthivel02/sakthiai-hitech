# Creator: Tamil captions, speech/avatar generation, Murugan scene planner

Base: PR #29 candidate `1bf5de3f6820850d9365f0f4d440d11343a6d9dc`. Adds forward-only migration **0016**. No provider call, no spend, no deployment.
Creator remains OUT of the R1/V1 beta scope; paid generation stays OFF (`CREATOR_PAID_GENERATION_ENABLED` unset).

## What is wired

Speech (`SPEECH`) and avatar video (`AVATAR_VIDEO`) are two more kinds on the **existing** Creator seam (`CreatorMediaProvider` → orchestrator → persistence → artifact persistence). They inherit, unchanged: durable generation rows, per-workspace idempotency, the spend hook (price → reserve → commit/release/unknown) with the six daily ledger limits, ambiguous-submission handling (`SUBMISSION_UNKNOWN`, never resubmitted), retry, and checksummed artifact persistence. No second provider or spend framework exists.

| Piece | File |
|---|---|
| Kinds, requests | `server/creator/types.ts` |
| Pricing (`perThousandChars` for speech, `perSecond` × rounded-up audio seconds for avatar), per-kind allowlists `CREATOR_PAID_SPEECH_USERS` / `CREATOR_PAID_AVATAR_USERS` | `server/creator/paidPolicy.ts` |
| Providers `sarvam-tts`, `heygen-avatar` | `server/creator/speech/creatorProviders.ts` (registered in `providerRegistry.ts`) |
| Router `creator.speechAvatar.{submitSpeech, reviewSpeech, submitAvatarVideo, recordConsent, revokeConsent, listConsents}` | `server/creator/speechAvatarRouter.ts` |
| Consent records | `server/creator/speech/consentStore.ts`, table `creatorConsents` (0016) |
| Approved-audio resolution for avatar | `server/creator/speech/audioAsset.ts` |
| Human speech review (PASS = approve + lock exact bytes; REJECT final; one per asset, race-safe) | `server/creator/speech/speechReview.ts`, review type `HUMAN_SPEECH` (0016) |
| User-facing explanations of every new refusal | `shared/creatorErrors.ts` |

Gate order (same as image/video): switch → workspace owner → kind-specific allowlist → spend policy → runtime readiness → consent (avatar) → approved audio (avatar) → orchestrator.

Design decisions:
- **TTS is synchronous**: `submit` synthesises once and writes the WAV to a random, provider-private staging key (`creator/staging/speech/<uuid>.wav`) that becomes the provider job id. Billed audio survives a crash between submit and persistence and is never synthesised twice for one generation. `poll`/`fetchArtifact` only accept that key pattern.
- **Avatar audio is server-resolved**: only an APPROVED + immutable WAV asset of the same workspace and project: the locked audio master, or generated speech after a workspace owner's `HUMAN_SPEECH` PASS. Generated speech is persisted as `AUDIO` / `PENDING` and is never auto-approved.
- **Consent before anything**: an unconsented, revoked, expired, wrong-purpose or wrong-subject avatar never causes a storage read, a ledger hold or a provider call. Consent stores an evidence *reference*, not the evidence or personal data.
- **Cancellation is honest**: HeyGen documents no in-flight cancel; the provider has no `cancel`, so the existing orchestrator refuses with `CREATOR_PROVIDER_CANCEL_UNSUPPORTED` (explained to the user: the job may still complete and be charged).
- **Provider test mode by default** for avatar (`live: false` → watermarked, unbilled). The ledger still reserves the priced amount (conservative).

## Migration 0016 (forward-only, additive)

1. `ALTER TABLE creatorGenerations MODIFY COLUMN kind enum(…,'SPEECH','AVATAR_VIDEO')` — members appended at the end; existing values and storage size unchanged.
2. `ALTER TABLE creatorReviews MODIFY COLUMN reviewType enum(…,'HUMAN_SPEECH')` — appended, existing values unchanged.
3. `CREATE TABLE creatorConsents` + one index.

The ALTER runs first, so an interrupted apply leaves at worst the consent table missing, which `/readyz` reports (`schema_mismatch`). The preview migration guard classifies 0016 (MODIFY COLUMN = no new object). Applying it to any shared database needs the existing owner-gated inspect → migrate sequence.

## Evidence classification

| Capability | State | Evidence | Not proven |
|---|---|---|---|
| Tamil caption font pinned in the FFmpeg render | IMPLEMENTED + RUNTIME_VERIFIED (local ffmpeg/libass) | defect reproduced, fix verified visually and by libass font-selection log; mutation-checked | production host ffmpeg build |
| Speech/avatar wiring (router → orchestrator → persistence) | IMPLEMENTED; unit + real-SQL tested | 10 router tests (real tRPC + orchestrator, fakes for DB/provider/ledger); real-SQL SPEECH generation through the real orchestrator and persistence (provider HTTP faked) → `AUDIO` asset, replay never re-bills | **MariaDB 10.11 only, not MySQL 8 / Aiven**; no live provider |
| Migration 0016 | IMPLEMENTED; real-SQL tested on MariaDB 10.11 | upgrade from 0015 preserves existing kinds, new kinds insertable, unknown kind refused (strict mode); guard full sequence and readiness through 0016 pass | MySQL 8.0/8.4 CI not yet run (needs push) |
| Consent store, approved-audio resolution | IMPLEMENTED; unit + real-SQL tested | workspace/purpose/subject binding, revoke permanence, expiry, scope checks | — |
| Sarvam / HeyGen adapters | CONTRACT_TESTED (documented shapes); NOT runtime-verified | — | no live call; Tamil voice quality unjudged; HeyGen v2 vs v3 to confirm at first approved call |
| Murugan planner, caption builder, audio sync, zero-spend render | as in the first patch (VGEN-validated plans incl. 84 scenes; render duration = master ±80 ms; synthetic audio, placeholder visuals) | | not a Murugan media acceptance |

## Environment (all unset by default; values never committed)

`CREATOR_TTS_SARVAM_API_KEY`, `CREATOR_AVATAR_HEYGEN_API_KEY`, `CREATOR_PAID_SPEECH_USERS`, `CREATOR_PAID_AVATAR_USERS`, `CREATOR_AVATAR_DOWNLOAD_HOSTS` (default `.heygen.ai,.heygen.com`), `CREATOR_CAPTION_FONTS_DIR` (default `server/creator/fonts`). Prices go in the existing `CREATOR_MODEL_COSTS`, e.g. `{"bulbul:v3":{"perThousandChars":…},"heygen-v2":{"perSecond":…}}`; an unpriced model is refused.

## UI, 9:16 delivery and export manifest

- **Creator page panel** (`client/src/pages/CreatorSpeechAvatarPanel.tsx`): speech generation (shot, ta-IN/en-IN, optional voice, exact text), listen-and-review (PASS enabled once the clip has played to the end — a UI prompt, not proof of listening; notes required), consent record/revoke with an explicit owner confirmation, avatar submission from active consents and approved/locked audio only (provider test mode unless "Live render" is ticked). Same-intent requests reuse the idempotency key. All refusals use `describeCreatorError`. Browser-tested (Playwright, desktop 1280 and Pixel 5): consent record → active → revoke; speech refused while paid generation is off with no generation row; no horizontal overflow.
- **9:16 mobile delivery** (`creator.timeline.renderVerticalDerivative`): 1080×1920, centre-crop (`fit: "cover"`), only from an APPROVED 16:9 final master of the same timeline, refused on any change to visuals or audio master since approval (`CREATOR_DERIVATIVE_SOURCE_DRIFT`). Provenance source `deterministic-creator-derivative`, so it can never be reviewed or promoted as a master. A human crop check (`creator.timeline.reviewVerticalDerivative`, recorded as `HUMAN_VISUAL` with `check: VERTICAL_CROP`) approves the derivative for delivery. Owner-only (like speech approval), checked before any database access. In the UI, PASS is enabled once the video has played through; that is a prompt, not proof that a person watched it. Notes required, one race-safe final decision, the 16:9 master untouched. The manifest reports `deliveryApproved`.
- **Export provenance manifest** (`creator.timeline.exportManifest`, `server/creator/exportManifest.ts`): export parameters, output checksum and kind (MASTER / DELIVERY_DERIVATIVE), audio master checksum, each visual's checksum and origin (provider, model, generation id, provider job id, avatar consent id, test mode), caption count/languages/hash, reviews and gate outcomes. Never contains storage keys, signed URLs or caption text. Workspace-scoped; download from each successful export.

Evidence: real ffmpeg 9:16 render with Tamil captions in the pinned font; real-SQL derivative and manifest through the real export service (ffmpeg and storage faked); unit tests for fit, drift and manifest redaction.

## Next (engineering, no approval needed to build)

1. Forced alignment for caption timing (today proportional, labelled `PROPORTIONAL_UNVERIFIED`).
