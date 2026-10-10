# Gemini Multimodal Correction-Pass Reconciliation — 2026-09-24

Status: RECONCILED INPUT / DELTA-ONLY ACCEPTANCE
Source input: user-provided Gemini correction pass (`Pasted text(20260924-125115).txt`)
Canonical repo: `ssakthivel02/sakthiai-hitech`

## Executive decision

The Gemini correction pass is materially closer to its assigned Prompt B role and is useful as a product/UX design input. It must not be ingested verbatim as implementation evidence.

The correction pass successfully supplies missing journey maps, non-paid fixtures, provider-neutral media interface concepts, Google/Gemini leakage warnings and failure-UX behavior. Several capability rows marked `PASS` are not proven by current canonical source/runtime evidence and are reclassified below.

Claude Prompt A does not need to be rerun for this cycle. Its architecture/security findings were already reconciled into the canonical control plane. A future Claude follow-up should be targeted only if a new architecture/security delta needs red-teaming.

## Source authority / lane boundary

At reconciliation time:
- PR #25 `feature/model-fabric-foundation` owns generic Core Intelligence, Model Fabric, Brain, governed skills/evals and provider-neutral control contracts.
- PR #7 `feature/creator-mvp` owns current Creator provider/runtime/database-sensitive implementation.
- live multimodal voice/screen/camera implementation is not automatically assigned to PR #7; it remains future integration work unless an explicit lane is assigned after current lanes reconcile.

No PR #7, database, Render, Aiven, DNS, secret or paid-provider state is changed by this Gemini ingestion.

## Capability-matrix corrections

### Accepted as design targets / backlog
The following are valid target capabilities, but the Gemini document is not proof they are currently implemented:
- image/audio/video understanding;
- screen/camera/live vision;
- live voice and interruption/full duplex;
- Tamil-English code switching;
- image editing and reference/character consistency;
- image-to-video, script/message/story/storyboard-to-video;
- video editing/extension/object/background replacement;
- subtitles and dubbing;
- voice design and consent-governed voice cloning;
- music/song/SFX;
- avatar/digital-human, lip sync and multilingual lip sync;
- mobile/offline/degraded-mode UX.

### PASS labels reclassified
Gemini marked English speech, STT, TTS, translation and text-to-image as `PASS`. These are not accepted as blanket PASS claims:
- `text-to-image`: current Creator source contains a Google image provider path, but runtime/provider acceptance is not yet proven; classify `SOURCE_IMPLEMENTED / RUNTIME_UNVERIFIED`.
- `STT`, `TTS`, `English speech`: no current canonical runtime evidence supplied by the Gemini audit proves production-ready speech engines; classify `UNVERIFIED / BACKLOG_OR_EXISTING-WORK-TO-RECONCILE`.
- `translation`: a general LLM may translate text, but dedicated translation quality/runtime acceptance is not proven; classify `PARTIAL / QUALITY_BASELINE_REQUIRED`.
- `text input`: basic application chat input is established; broader multimodal chat acceptance remains separate.

No external-specialist report may promote a capability to canonical `PASS` without source/runtime evidence from the owned implementation lane.

## Journey maps — ACCEPTED AS UX TARGETS

The following Gemini journeys are accepted as product design targets:
1. Chat: multimodal input -> asset handling -> understanding -> Model Fabric -> streaming response -> citations -> follow-up -> governed fallback.
2. Creator: idea/script -> references -> storyboard -> editable shots -> generation -> review -> selective regeneration -> timeline -> captions/dubbing -> quality gates -> export.
3. Voice: microphone -> VAD -> STT -> language/code-switch detection -> Brain/Model Fabric -> response -> TTS -> barge-in -> history/resume.
4. Live multimodal: voice/camera/screen/documents -> synchronized context -> tools -> interruption -> permissions/safety -> reconnect/recovery.
5. Mobile: chunked/resumable uploads, background jobs, progress, cancel/retry, offline drafts, reconnect, partial results, accessibility and bandwidth/device adaptation.

Correction: provider fallback must never be silent when it changes spend policy, privacy boundary, provider class or materially degrades quality. External/metred fallback requires explicit routing policy and spend permission.

## Provider-neutral media contracts — ACCEPTED AND SOURCE-IMPLEMENTED IN PR #25

Added `server/media-contracts/*` as provider-independent control-plane contracts for:
- image;
- video;
- speech-to-text;
- text-to-speech;
- music;
- avatar;
- live multimodal.

Common contracts include:
- tenant/request identity;
- stable idempotency key;
- local/self-hosted/external provider class;
- local-compute/metered/subscription billing class;
- progress and cancellation capability metadata;
- asset references/checksums;
- structured provenance references;
- structured rights/consent references with validity/revocability rather than a single boolean;
- cost/resource metadata;
- quality/human-review metadata;
- provider-neutral error codes.

Fail-closed policy rules include:
- external providers require explicit external-provider permission;
- metered APIs require explicit spend permission;
- identity/voice use can require an unexpired structured rights record;
- missing tenant or idempotency identity blocks execution;
- fallback selection cannot bypass provider/spend policy;
- materially degraded fallback requires a user-visible notice.

This is a control contract only. It does not activate any media engine or provider.

## Gemini-specific leakage list — ACCEPTED

Do not bake the following provider-specific details into SakthiAI core contracts:
- Google-specific `safetySettings` enum vocabulary;
- Google File Manager `fileUri` lifecycle assumptions;
- Gemini SDK-specific role/message structure;
- Veo/Imagen-specific enum representations for generic dimensions/aspect ratios;
- Google-only SSML or voice semantics.

Provider adapters translate between SakthiAI generic contracts and provider-specific fields.

## Non-paid fixtures — ACCEPTED FOR FUTURE TEST IMPLEMENTATION

Gemini's proposed zero-credit fixture categories are useful:
- image-understanding fixture;
- document+image fixture;
- recorded speech fixture;
- Tamil speech fixture;
- Tamil-English code-switch fixture;
- video-understanding fixture;
- deterministic three-shot storyboard fixture;
- static avatar MP4 fixture;
- VTT/SRT fixture;
- simulated provider 503/timeout/quota failures;
- offline/reconnect queue fixture.

Mocks prove orchestration/UI behavior only. They must not be described as proof of real model/media quality.

## Tamil / English benchmark rubric — PARTIAL ACCEPT

Accepted measurement dimensions:
- Tamil WER/CER;
- English WER;
- Tamil-English code-switch accuracy;
- partial/final transcription latency;
- pronunciation naturalness;
- TTS human/MOS rating;
- speaker similarity;
- translation adequacy;
- subtitle accuracy/timing;
- lip-sync offset;
- avatar identity consistency.

Gemini's numeric thresholds are `PROPOSED`, not canonical gates, unless backed by a representative SakthiAI dataset and baseline evidence. In particular:
- Tamil metrics remain `BASELINE_REQUIRED`;
- code-switch remains `BASELINE_REQUIRED`;
- translation must not use a generic `>0.85 BLEU/ChrF` rule without defining metric scaling, dataset and language/domain baseline;
- latency gates must be measured separately by device/network/local-vs-remote execution class;
- lip-sync and subtitle timing thresholds require frame-rate/sample-rate aware evaluation.

## Failure UX — ACCEPTED WITH GOVERNANCE CORRECTION

Principles accepted:
- preserve user prompt/assets/draft state across recoverable failures;
- show partial generations rather than discarding successful work;
- retry only the failed shot/segment where possible;
- keep original media on STT/TTS failures;
- support pause/reconnect for uploads;
- expose a clear unavailable/degraded state.

Correction: `local model unavailable -> automatic cloud` is forbidden unless `allowExternalProviders=true` and, for metered APIs, `allowMeteredSpend=true`. Otherwise stay local/degraded or clearly report that the requested capability is unavailable.

## Priority reconciliation

### Existing P0 remains authoritative
Gemini's UX items do not replace current external-beta P0 gates:
1. server-side session/token revocation;
2. malware scanning/quarantine;
3. live two-tenant isolation/adversarial replay acceptance;
4. exact deployed SHA/readiness/DB/runtime acceptance;
5. required security/privacy/human acceptance.

### P1 / product-completeness additions
- provider-neutral media engine contracts (control plane added in PR #25; runtime adapters remain future work);
- failure/degraded-mode UX;
- resumable/chunked upload architecture where launch surface requires it;
- deterministic non-paid media fixtures;
- Tamil/code-switch benchmark corpus and baseline;
- VAD/streaming speech contracts;
- Creator storyboard and selective-regeneration verification against PR #7 before any duplicate implementation.

### P2 / advanced
- consent-governed expressive voice cloning;
- open avatar/lip-sync engine qualification;
- local VLM prompt enhancement;
- local/open video engine qualification;
- full duplex live multimodal runtime.

## DO NOT DO

- Do not rerun the full Gemini architecture audit.
- Do not rerun Claude Prompt A now.
- Do not treat Gemini's PASS labels as canonical evidence.
- Do not silently fall back to paid cloud providers.
- Do not store consent as a simple boolean; use auditable/revocable rights records.
- Do not implement live multimodal work by modifying PR #7 unless ownership is explicitly assigned after reconciliation.
- Do not activate paid image/video/voice/avatar providers from this reconciliation.
- Do not claim provider-neutral control contracts mean the corresponding engines are live.
