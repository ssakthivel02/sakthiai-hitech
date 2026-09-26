# SakthiAI Core Intelligence / Model Fabric Foundation

Status: SOURCE FOUNDATION ONLY — NO PROVIDER ACTIVATION, NO API KEYS, NO PAID CALLS, NO PRODUCTION CLAIM

## Goal

Build SakthiAI's own application-level intelligence stack so the product can progressively match the useful capabilities users expect from leading AI systems: high-quality chat, deep research, coding, agentic work, tools, browser/computer workflows, memory, RAG, provenance, multimodal input, long-context work, evaluation, approvals, and reliable task execution.

This work deliberately does **not** claim to copy proprietary model weights, training data, hidden reasoning, private chain-of-thought, or undisclosed provider internals. Product architecture and orchestration can be reproduced and improved independently; frontier-model intelligence still depends on the qualified model/runtime underneath it.

## Zero-spend rule

The first implementation phase must work without paid model APIs:

- no OpenAI, Anthropic, Google, Kimi, Manus or other paid-provider key is required;
- no provider credential is committed to Git;
- no external paid model is runtime-enabled by this foundation;
- external/frontier entries may exist only as disabled architectural references;
- local/open-weight engines are enabled only after separate runtime qualification;
- cloud GPU or paid VM provisioning requires a separate owner decision.

## Target product capabilities

1. **Chat & reasoning** — conversational state, structured outputs, deliberate reasoning modes, response verification and retry policies.
2. **Research** — query planning, source collection, RAG, source confidence, provenance, citation coverage and synthesis.
3. **Work / agents** — planner, specialist workers, task graph, checkpoints, resumability, approvals and bounded retries.
4. **Coding** — repository context, edit planning, test execution, code review, patch verification and rollback-aware workflows.
5. **Browser / computer work** — isolated action plans, permission boundaries, screenshots/state capture, step verification and human approval for risky actions.
6. **Memory & knowledge** — tenant-scoped memory, retrieval, knowledge graph links, freshness, provenance and source authority.
7. **Multimodal** — text, documents, images, audio/video understanding and separate qualified generation engines.
8. **Long-context work** — context budgeting, hierarchical summaries, retrieval-before-stuffing, compaction and reusable working memory.
9. **Evaluation** — task-success, factuality, grounding, retrieval quality, tool success, coding tests, latency and safety evaluation.
10. **Trust & control** — tenant isolation, RBAC, secrets, approval gates, spend gates, sandboxing, audit and fail-closed execution.

## SakthiAI Brain architecture

```text
User / App / Voice / Mobile
          |
          v
Intent + Risk Classifier
          |
          v
Context Builder
(memory + RAG + files + provenance + summaries)
          |
          v
Planner / Task Graph
          |
          v
Model & Skill Router  <---- this foundation
          |
          +--> Local / self-hosted model runtime
          +--> Retrieval / search / graph
          +--> Code / files / browser / connectors
          +--> Specialist sub-agents
          |
          v
Verifier / Evaluator
          |
          v
Safety + Approval + Spend Gate
          |
          v
Grounded Result + Evidence + Audit
```

## Model Fabric contract

The Model Fabric routes by **capability and evidence**, not by brand name.

Each execution profile declares:

- capabilities;
- preferred task intents;
- supported reasoning effort;
- local / self-hosted / external provider type;
- local-compute / metered billing mode;
- minimum compute envelope;
- runtime-enabled state;
- implementation/qualification status.

The router fails closed when:

- a runtime is disabled;
- a required capability is absent;
- a requested reasoning level is unsupported;
- declared compute is insufficient;
- an external provider is not explicitly allowed;
- metered billing is not explicitly allowed;
- network use is disabled for an external provider.

This makes the same orchestration layer usable later for small local models, larger self-hosted models, or funded external frontier models without rewriting the application.

## Why '99% brain' is not a valid current claim

A product can achieve strong task success through retrieval, planning, tools, verification, memory, specialist agents and model routing. Those layers can sometimes outperform a stronger standalone model on a bounded workflow.

However, raw model reasoning quality comes from the model's learned weights, training, inference stack and compute. A low-cost CPU VM cannot honestly be claimed to reproduce a frontier model's general intelligence. SakthiAI therefore uses measurable acceptance gates instead of an unsupported percentage claim.

### Required comparative metrics

- end-to-end task success;
- grounded factual correctness;
- citation/source coverage;
- coding test pass rate;
- retrieval precision/recall and answer grounding;
- tool/action success rate;
- long-horizon completion rate;
- latency and resource use;
- safety/policy adherence;
- human acceptance on representative workflows.

Only benchmark evidence may support comparative performance claims.

## Deployment reality

### CPU / free VM

Suitable for:
- SakthiAI control plane;
- task routing and orchestration;
- metadata, queues and schedulers;
- RAG/search/provenance;
- small embeddings and compact local models;
- tests, evaluation harnesses and development.

Not suitable for claiming frontier-scale general inference.

### Modest GPU later

A qualified 16–48 GB VRAM GPU can make useful quantized open-weight reasoning/coding/vision models practical. Actual model selection must be benchmarked against SakthiAI workloads before activation.

### Large frontier-open models

Very large open-weight systems may require multi-GPU or cluster inference. Do not provision this class of infrastructure until benchmarks show that it is necessary and funding exists.

## Delivery phases

### Phase 0 — Foundation (this lane)
- capability/task taxonomy;
- provider-independent model profiles;
- deterministic routing policy;
- zero-spend / external-provider fail-closed rules;
- compute-envelope checks;
- unit tests;
- no runtime/provider activation.

### Phase 1 — Local runtime
- select 2–3 open-weight candidates through benchmark evidence;
- add local inference adapter (for example an OpenAI-compatible self-hosted endpoint);
- enable one compact model first;
- benchmark chat, reasoning, coding, Tamil/English and RAG;
- retain fallback and timeout controls.

### Phase 2 — SakthiAI Agent Brain
- planner + task graph;
- specialist agents;
- tool registry;
- checkpoint/resume;
- bounded retries;
- verifier/judge layer;
- human approval gates.

### Phase 3 — Research / memory / multimodal
- research planner and source authority;
- durable tenant-scoped memory;
- knowledge graph relationships;
- image/document/audio/video perception adapters;
- voice pipeline;
- browser/computer-use sandbox.

### Phase 4 — Competitive evaluation
- representative benchmark suite against leading AI product workflows;
- automated regression gates;
- latency/resource dashboards;
- factuality/grounding and coding acceptance;
- no marketing superiority claim without evidence.

### Phase 5 — Optional funded frontier adapters
- add external providers only behind the existing Model Fabric;
- secrets remain outside Git;
- explicit owner approval before provider activation/spend;
- per-request budget and quota controls;
- provider fallback without application rewrites.

## Integration hold while Creator PR #7 is active

This foundation intentionally does not modify:

- `server/_core/llm.ts`;
- `server/_core/env.ts`;
- `render.yaml`;
- database schema or migrations;
- Creator runtime/provider code;
- runtime secrets or provider credentials.

Those are high-risk overlap surfaces owned by the active Creator lane. Integration with the live LLM adapter must occur only after PR #7 is reconciled/closed or after a deliberate exact-head conflict review.

## Acceptance for this foundation

This phase is complete only when:

1. source changes are isolated to a dedicated branch;
2. router tests pass;
3. TypeScript checks pass;
4. existing repository quality gates remain green;
5. no provider key, paid call, cloud resource, database change or deployment was introduced;
6. no existing Creator files were modified;
7. merge remains a separate owner-reviewed action.
