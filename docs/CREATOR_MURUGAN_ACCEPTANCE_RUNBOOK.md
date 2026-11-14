# SakthiAI Creator — Murugan Runtime Acceptance Runbook

Status: REQUIRED before any claim that SakthiAI Creator is production-ready, has replaced a paid external subscription, or has passed a real Murugan production workflow.

This runbook is intentionally evidence-first. It authorises no production deployment, DNS change, billing purchase, secret commit, automatic publishing, or destructive repository action.

## 1. Acceptance objective

Prove one complete, bounded Murugan media-production sequence through the actual SakthiAI Creator runtime:

approved audio → project/scene/shot plan → image/video generation → durable artifact persistence → approved visual timeline → Tamil captions → deterministic 16:9 render → SakthiAI quality review → human Tamil review → human visual review → approved final master.

The first acceptance sequence should be deliberately small: approximately 20–40 seconds, normally 4–6 shots. Do not attempt a full movie before this bounded sequence passes.

## 2. Runtime preconditions

Before spending provider credits or generating media, verify all of the following in the approved runtime environment:

- Creator database migration applied;
- authenticated SakthiAI workspace available;
- S3-compatible storage configured and writable;
- Google image provider credential configured outside Git;
- Google Veo credential configured outside Git;
- FFmpeg runtime available to the render worker;
- no credential, access key, signed URL, token, or secret is committed to Git, pasted into PR comments, or stored in test fixtures;
- `/creator` loads for the authorised user;
- Creator provider status reports the intended provider as configured.

If any precondition fails, STOP. Do not submit a generation job merely to discover a configuration problem.

## 3. Acceptance media lock

Record the exact inputs before generation:

- project name;
- approved audio filename;
- approved audio SHA-256;
- exact audio duration;
- lyric/caption source version;
- Tamil text reviewer/source;
- Murugan visual intent/reference-set identifier;
- number of planned shots;
- exact prompt for each shot;
- intended aspect ratio: `16:9`;
- target output: `1920×1080` unless a separately approved higher-resolution test is being run;
- target frame rate;
- selected image model;
- selected video model.

Do not silently change these inputs after generation. If a material input changes, create a new acceptance attempt.

## 4. Low-cost first-pass strategy

For the first runtime proof:

1. Use one short approved audio excerpt, approximately 20–40 seconds.
2. Create 4–6 storyboard shots covering the full excerpt.
3. Start with the lowest provider settings that are still representative of production intent.
4. Generate still reference/anchor images first where visual continuity matters.
5. Generate video only after the corresponding shot prompt/reference intent is accepted.
6. Do not generate multiple speculative variants in parallel without a recorded reason.
7. Record provider-reported or account-visible cost evidence for every billable generation where available.

The goal is to prove the pipeline, not maximise spend.

## 5. Murugan visual-quality requirements

Human visual review must explicitly assess:

- Murugan identity is stable enough across shots for the intended sequence;
- Vel is visually coherent and not malformed;
- peacock, costume, jewellery and devotional iconography are respectful and internally consistent where shown;
- hands, face, eyes, limbs and anatomy do not contain distracting generation defects;
- no unintended text, logos, watermarks or foreign symbols appear;
- camera motion is plausible and does not introduce severe warping/flicker;
- temple/background continuity is acceptable for the scene;
- generated content does not materially contradict the approved storyboard/reference intent;
- no shot is accepted merely because the provider returned a successful job status.

A provider success is not a visual PASS.

## 6. Tamil/audio requirements

Human Tamil review must explicitly assess:

- caption text exactly matches the approved Tamil source for the excerpt;
- no dropped, duplicated or substituted Tamil words;
- caption cue boundaries are intelligible against the vocal line;
- captions do not overlap incorrectly;
- captions remain within the approved audio master duration;
- UTF-8 rendering is correct;
- punctuation and line breaking remain readable on a 16:9 video;
- audio is not truncated, repeated, time-stretched unexpectedly, or replaced;
- final render duration matches the approved audio master intent.

No automatic or model-generated transcript should be treated as authoritative Tamil text without human verification.

## 7. Artifact persistence evidence

For each generated image/video used in the acceptance sequence, record:

- SakthiAI generation ID;
- provider job ID;
- provider/model;
- project ID / scene ID / shot ID;
- generated asset ID;
- persisted storage key;
- SHA-256 checksum;
- MIME type;
- byte size;
- provenance record presence;
- whether the asset can be retrieved from storage after the provider job has completed.

PASS requires durable SakthiAI-controlled persistence. A temporary provider URL alone is insufficient.

## 8. Timeline acceptance

Before rendering:

- every timeline visual must be an approved SakthiAI asset;
- timeline coverage must begin at 0 ms;
- timeline coverage must end exactly at the audio master duration;
- no visual gap is permitted;
- no visual overlap is permitted unless the implementation explicitly supports and evidences it;
- caption cues must be locked;
- caption cues must remain within the audio master duration;
- shot ordering must match the approved storyboard.

If the deterministic render planner rejects the timeline, fix the project data; do not bypass the validation.

## 9. Deterministic render evidence

Record:

- render/export ID;
- render asset ID;
- renderer/version where available;
- width and height;
- frame rate;
- duration;
- audio parameters;
- subtitle/caption inclusion;
- final output SHA-256;
- persisted storage key;
- render start/end timestamps;
- elapsed render time;
- any runtime warning/error.

The first acceptance target is a deterministic `16:9` candidate with the approved audio master and locked Tamil captions.

## 10. SakthiAI quality gate

Run the governed quality review against the actual rendered asset. Record every score and any critical defect.

The following dimensions must be assessed using the existing SakthiAI video-quality specification:

- content fidelity;
- temporal quality;
- identity consistency;
- visual quality;
- camera/motion quality;
- audio quality;
- text/caption quality;
- delivery/output conformance.

Do not pre-fill perfect scores merely to advance the workflow. Scores must reflect the viewed/listened output.

If the quality gate says regenerate/reject, the acceptance attempt has not passed.

## 11. Human gates

A real person must view/listen to the final rendered candidate before recording:

- `HUMAN_TAMIL: PASS`;
- `HUMAN_VISUAL: PASS`.

Each review must include meaningful notes tied to the actual output. Do not record human PASS before the asset exists or before it has been inspected.

Final-master promotion is allowed only after:

- SakthiAI quality PASS;
- Tamil PASS;
- visual PASS.

Final-master promotion does not mean automatic publishing approval.

## 12. Cost/time evidence

For the acceptance attempt, record:

- image-generation count;
- video-generation count;
- retries/regenerations;
- provider cost evidence where available;
- total provider spend for the sequence;
- total generated seconds;
- successful final seconds;
- wall-clock generation time;
- render time;
- manual review time;
- reason for every regeneration.

Only after this evidence exists may SakthiAI be compared with Runway or another provider for cost/quality efficiency.

## 13. Stop conditions

STOP the acceptance run if any of the following occurs:

- runtime credential exposure;
- provider or storage configuration uncertainty;
- database migration uncertainty;
- unexpected project/workspace ownership failure;
- persistent artifact cannot be retrieved;
- exact audio master is uncertain;
- Tamil source is uncertain;
- provider spending exceeds the pre-agreed test budget;
- another ChatGPT/human task materially changes the active PR branch during the run;
- P0 security/data-integrity issue appears.

Do not solve a stop condition using force-push, reset, bypassed CI, weakened GitHub rules, or deletion of another task's work.

## 14. Acceptance record template

- Date/time:
- Tester:
- Runtime/environment:
- PR number:
- Exact PR head SHA:
- Exact main SHA:
- Creator project ID:
- Audio asset ID/checksum:
- Reference-set ID:
- Planned shots:
- Image generation IDs:
- Video generation IDs:
- Persisted asset IDs/checksums:
- Timeline ID:
- Caption evidence:
- Render/export ID:
- Render checksum:
- Quality decision:
- Human Tamil decision:
- Human visual decision:
- Total cost:
- Total elapsed time:
- Defects/regenerations:
- Final acceptance decision: `HOLD` / `CONDITIONAL_GO` / `PASS`
- Notes:

## 15. Claim boundary

Passing this one bounded sequence proves only that the tested SakthiAI Creator runtime completed that exact acceptance workflow under the recorded conditions.

It does not by itself prove:

- unlimited production scalability;
- permanent provider independence;
- Runway Max replacement for every use case;
- lower cost for all workloads;
- production deployment approval;
- YouTube publishing approval;
- legal/commercial rights for arbitrary source media;
- zero-defect Tamil or visual generation in future jobs.

Those claims require their own evidence.
