# SakthiAI Master Capability Scope — One Complete AI Platform

Status: CANONICAL PRODUCT SCOPE / IMPLEMENTATION TRACK LOCK
Date: 2026-09-24

## Product rule

SakthiAI is one end-to-end AI platform. A new request adds to this master scope; it does not replace or narrow previously accepted scope unless the owner explicitly removes a requirement.

The product is not limited to chat, Creator, RAG, agents, or one model. It must converge into one coherent platform with a shared identity, workspace, memory, permissions, files, tools, model fabric, agents, media stack, evaluation system and operations layer.

## Current canonical implementation lanes

1. `main` — canonical integration baseline.
2. PR #7 / `feature/creator-mvp` — existing Creator/runtime/media lane. Do not duplicate or edit its owned runtime/provider files from another lane.
3. PR #25 / `feature/model-fabric-foundation` — Core Intelligence lane for Model Fabric, Brain, governed skills, evaluation and this master capability registry.

No third duplicate implementation lane should be created for capabilities already owned by these lanes.

## Master product domains

The machine-readable register in `server/platform-capabilities/catalog.ts` is the canonical breadth inventory. It deliberately tracks more than 300 product capabilities across sixteen domains.

### 1. Chat and reasoning
Adaptive chat, instant/deep/max reasoning, multilingual and Tamil-first conversation, structured output, long-context handling, conversation branching/search, verification, uncertainty, citations, compaction, prompt libraries and workspace instructions.

### 2. Research and search
Web and deep research, multi-query planning, parallel search, source authority/freshness, citation coverage, claim-source linking, academic/news/finance search, document+web fusion, research agents, fact cross-checking, contradiction detection and source confidence.

### 3. Coding and software creation
Repository understanding, code search/generation/edit/review, debugging, test generation/execution, terminal work, dependency analysis, migrations, refactoring, performance and security review, design-to-frontend, app scaffolding, visual checks, rollback plans and release notes.

### 4. Agents and automation
Planner, task graph, specialist agents, multi-agent orchestration, swarms, parallel sub-agents, checkpoint/resume, bounded retries, tool budgets, approvals, risk classification, verifier/critic/synthesizer, background and scheduled tasks, condition monitoring, durable long-running jobs and human handoff.

### 5. Knowledge, RAG and memory
Lexical/semantic/hybrid retrieval, reranking, tenant isolation, short/long-term memory, user/project/agent memory, knowledge graph, entity links, provenance, freshness, compaction, editing/forgetting, cross-file retrieval and retrieval evaluation.

### 6. Documents, files and data
PDF/DOCX/XLSX/PPTX understanding, OCR, tables/charts, citations, comparison, translation/rewrite, spreadsheet analysis/generation, presentations, PDF output, data cleaning/visualization, sandboxed computation, artifact versioning and export.

### 7. Image creation and editing
Text-to-image, image-to-image, edit, inpaint/outpaint, background removal/replacement, transparency, style transfer, references, consistent characters, product visuals, posters, infographics, diagrams, UI mockups, text rendering, upscale/restoration, face-preserving edit and batch generation.

### 8. Video creation and editing
Text/image/script/message/story/storyboard-to-video, first/last frame, reference video, video-to-video/restyle, scene and shot generation, extension, upscale/interpolation, captions/subtitles, timeline editing, trim/split/merge, transitions, camera control, reframe, cinematic finishing, FFmpeg rendering, resumability and provenance.

### 9. Audio, voice and music
STT, streaming STT, diarization, language ID, forced alignment, TTS, expressive/multilingual speech, voice design, consent-based cloning, conversion, speech translation, live interpretation, denoise/enhance/edit/mix/master, stem separation, SFX, text-to-music, instrumentals, songs, lyrics-assisted songs, extension/remix, podcasts and audiobooks.

### 10. Avatars and digital humans
Photo/custom avatars, avatar-to-video, scripted presenters, talking photos, lip sync, multilingual lip sync, avatar voice, background, gestures, emotion, camera direction, live digital humans, brand kits, scene templates, identity consistency and consent records.

### 11. Live multimodal interaction
Image/video/audio/screen/camera understanding, live and full-duplex voice, interruption, live vision, screen-sharing assistance, meetings, real-time translation, multimodal reasoning, cross-modal search/memory and event understanding.

### 12. Apps, websites and artifacts
Website/web-app/mobile-app/dashboard/form/workflow builders, presentation/document/spreadsheet builders, interactive artifacts, generative UI, preview/sandbox runtime, export, hosting/custom-domain adapters, SEO and accessibility auditing.

### 13. Tools, connectors and actions
Browser/computer use, filesystem/shell tools, GitHub/GitLab, Gmail/Outlook, Calendar/Drive, Slack/Teams/Notion, databases/cloud, MCP client/server, A2A, webhooks, API tool builder, custom skills and connector permissioning.

### 14. Enterprise trust and governance
Authentication, OIDC/SSO/RBAC, tenant/workspace/project isolation, secret management, approvals, audit, retention/privacy, data export/delete, provenance/watermarks, prompt-injection defense, tool sandboxing, network egress, spend/quota policy, abuse/safety, admin console and org controls.

### 15. Model Fabric and local AI
Model registry, capability/intent/reasoning/compute routing, local-first and self-hosted routing, paid-provider/spend gates, fallback/ensemble/specialist routing, benchmark-driven selection, local LLM/VLM/embedding/STT/TTS/image/video adapters, quantization, CPU/GPU inference, model health and version pinning.

### 16. Operations and observability
Health/readiness/release identity, logging/tracing/metrics, latency/cost/token/GPU/queue/agent/capability/evaluation dashboards, SLOs, rate limits, circuit breakers, retry, rollback, backup/restore, disaster recovery, feature flags, canary release, drift detection, security monitoring and quality regression gates.

## Competitor-learning rule

SakthiAI should continuously study public capabilities of leading AI systems and convert two things into product requirements:

1. **Strength to match** — a useful public capability worth implementing.
2. **Tradeoff to beat** — cost, lock-in, fragmented UX, external dependency, hardware burden, weak provenance, missing governance, or another evidence-backed product limitation that SakthiAI can address through architecture.

This is not a request to copy proprietary weights, hidden prompts, training data, private chain-of-thought, trademarks, or closed implementation details.

The current evidence-backed seed register covers OpenAI GPT-6/ChatGPT, Claude Fable, Gemini, Kimi K3, DeepSeek V4.1, Qwen, Mistral, Grok, Perplexity, Manus, Runway, HeyGen and Suno. The register is intentionally not a ranking. It must expand in evidence-backed batches toward 100+ relevant model/product families without inventing unsupported entries.

## Public feature signals observed on 2026-09-24

- GPT-6 Astra emphasizes computer use, browsing, software engineering, vision, tools and large-context professional work.
- Claude Fable 5.1 emphasizes long-running agents, coding, browser operation, vision and enterprise knowledge work.
- Gemini combines frontier/agent models with live voice, proactive Spark agents, Omni media generation, TTS and cross-app actions.
- Kimi K3 combines open weights, native vision, 1M context, long-horizon coding and agent/swarm workflows, but its 2.8T scale makes inexpensive self-hosting difficult.
- DeepSeek V4.1-Flash emphasizes efficient sparse inference, native vision and reduced cache cost, while still being a very large model family.
- Qwen spans open multimodal/coding/agent models, image generation/editing, speech recognition and native omnimodal agents.
- Mistral spans open generalist/edge models plus specialist OCR and speech systems.
- Grok 4.7 emphasizes long-running coding/knowledge work and self-checking; Grok Voice includes real-world transcription.
- Perplexity combines cited web research, multi-model routing, Computer, continuous tasks, connectors and Brain memory.
- Manus combines autonomous planning, cloud computer, browser actions, scheduled tasks, connectors, app/slides/video work and reusable skills.
- Runway provides prompt-driven video editing and transformation workflows.
- HeyGen provides digital avatars, talking videos, voice/lip synchronization and multilingual video translation.
- Suno v6/Studio provides song generation, section editing, remix/mashup, sound generation and DAW-like editing.

## Production-first rule

Breadth work and production closure run side by side, but production claims remain evidence-gated.

### Track A — close currently built core to production
- Reconcile exact current main and both active PR heads before any action.
- Finish preview/runtime qualification for already implemented core and Creator capabilities.
- Prove auth, tenant isolation, DB migrations/recovery, storage, RAG/grounding, exact release identity, readiness, rollback and manual acceptance.
- Merge only after exact-head CI/runtime evidence and explicit owner approval.
- Do not block production of proven core capabilities merely because all 300+ future capabilities are not finished.

### Track B — expand the complete SakthiAI platform
- Continue Model Fabric and Brain.
- Add local/self-hosted inference adapters through benchmark evidence.
- Build memory/RAG/search/research, durable agents and governed tools.
- Expand image/video/avatar/audio/music pipelines.
- Add multimodal live interaction, apps/artifacts, connectors, enterprise controls and operations.
- Continuously benchmark against the competitor capability register.

## Zero-spend-first architecture

Until funding exists, paid model/API activation is not a prerequisite for product engineering. Build the contracts, routing, orchestration, UI, storage, governance, local pipelines and evaluation first. Use CPU/small local models where they genuinely pass workload benchmarks. Introduce GPU infrastructure only when measured workloads require it. Paid external models remain optional, owner-approved adapters behind spend gates.

## Dashboard persistence rule

This file plus `server/platform-capabilities/catalog.ts` and `server/platform-capabilities/competitors.ts` form the source-controlled master capability dashboard. GitHub Issue #1 is the human launch-control summary. A future runtime/database dashboard may read this registry, but no database migration should be created from this lane while the Creator/runtime lane owns active database/runtime changes.

Every future SakthiAI task should first reconcile against this register and the active PR ownership map. Completed capabilities are reviewed/qualified, not recreated.
