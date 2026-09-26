# SakthiAI Claude Prompt-A Red-Team Reconciliation — 2026-09-24

Status: CANONICAL RECONCILIATION RECORD
Canonical repository: `ssakthivel02/sakthiai-hitech`
Input audit: `claude/SAKTHIAI_ARCHITECTURE_REDTEAM_AUDIT_CLAUDE.md` (Prompt A, 2026-09-24)

## Source-authority decision

The supersession decision is now explicit and controlling:

1. `ssakthivel02/sakthiai-hitech` is the canonical active SakthiAI product/runtime repository.
2. `ssakthivel02/sakthiai` is a legacy/reference repository. Its Cloudflare Workers/D1/R2/runtime evidence must never be silently treated as evidence for the canonical Node/Express/tRPC/MySQL/Render runtime.
3. Useful design patterns from the legacy repository may be ported only through a fresh, reviewed change in `sakthiai-hitech` with new tests/evidence.
4. At reconciliation time the legacy repository still had open PR #5 and PR #17. Do not modify, merge, close, or advance those PRs from this lane while another task may own them. Their existence is a coordination risk, not a reason to revive the legacy repository as canonical.
5. If any old document calls `sakthiai` the flagship/canonical implementation, this record and the current `sakthiai-hitech` ACTIVE MASTER controls for current engineering work.

This resolves the historical naming/source ambiguity without rewriting historical evidence.

## PR #25 evidence gap — resolved

PR #25 (`feature/model-fabric-foundation`) is live and inspectable. Reconciled exact head before this follow-up work: `48d916219f6317438452d0979a18317440f89862`.

It contains the Model Fabric router/catalog, Brain planner/orchestrator/verifier, governed skills, eval scoring, master capability registry, competitor-learning registry and external-specialist contracts. Exact-head CI was green before this reconciliation update.

Evidence boundary remains important: these are source/control-plane capabilities. They do not prove live local-model inference, persistent agent execution, external MCP connectivity or production readiness.

## Claude finding reconciliation

| Claude finding | Canonical classification | Reconciliation / action |
|---|---|---|
| G1 two SakthiAI codebases | RESOLVED_WITH_RESIDUAL_COORDINATION_RISK | `sakthiai-hitech` already declares itself canonical and old/legacy repositories read-only. This record makes the disposition explicit. Legacy repo still has open PRs, so no destructive cleanup is performed here. |
| G2 PR #25 unknown | RESOLVED | Live PR/file/CI evidence exists. Do not mark Brain/Model Fabric/evals UNKNOWN. |
| G3 no durable agent execution | ACTION_REQUIRED / PARTIAL | PR #25 has a real in-memory planner/orchestrator with approvals and bounded retries/tool calls, but lacks durable persistence/checkpoint/idempotency/resume. This reconciliation adds provider-neutral checkpoint/idempotency contracts only; a durable backing store remains required before runtime claims. |
| G4 no RAG/vector retrieval | REJECT_STALE_FOR_CANONICAL | Canonical main already has document ingestion, embeddings, lexical/semantic/hybrid retrieval, workspace filtering before fusion, grounded chat and citations. Live runtime qualification is still separate. |
| G5 Model Fabric = one managed provider | RECLASSIFIED / PARTIAL | PR #25 now models local, self-hosted and external provider kinds with compute/billing/provider gates. All local/self-hosted profiles intentionally remain runtime-disabled until a real engine is qualified. Real Ollama/llama.cpp/vLLM/etc. integration remains a gap. |
| G6 MCP priority | ACCEPTED | MCP should precede A2A for near-term connector/tool interoperability. This reconciliation adds a fail-closed MCP control-plane contract; no external MCP server is activated. |
| G7 no eval harness | RECLASSIFIED / PARTIAL | PR #25 includes evaluation scoring and regression tests. Missing: runtime golden-dataset/model/RAG/agent outcome evaluation connected to releases. |
| G8 session revocation | ACCEPTED P0 | Stateless long-lived application session/JWT revocation remains an external-beta blocker. Keep owner-controlled preview boundary until closed. |
| G9 malware scanner | ACCEPTED P0 | Canonical runtime still reports `SCANNER_NOT_CONFIGURED`; uploaded files must not be considered production-safe until scanning/quarantine exists. |
| G10 tenant isolation unverified | RECLASSIFIED | Source-level tenant/workspace authorization and regression tests exist; live deployed multi-tenant verification is still required before external beta. |
| G11 no consent/rights/provenance schema | PARTIALLY_ACCEPTED | PR #7 already has mandatory `provenanceJson` on Creator assets. Explicit consent/rights/revocation fields/records remain missing and should be added in the Creator/runtime lane before identity/voice/avatar generation is enabled. Do not change PR #7 from PR #25. |
| G12 no real-DB migration CI | ACCEPTED | Add ephemeral/isolated real-MySQL migration validation in the appropriate runtime/CI lane; do not use production/preview data as a CI target. |
| G13 rate-limit identity spoofing | REJECT_STALE_FOR_CANONICAL SOURCE | Canonical protected procedures rate-limit using authenticated `ctx.user.id`, not a client-supplied identity header. Remaining gap is distributed/global quota enforcement for multi-instance/high-scale operation. |
| G14 governance is only reporting | PARTIAL | PR #25 has executable policy decisions for model/skill routing, but full deployment/release hard-gate enforcement is not yet universal. Keep as operations/governance work. |
| G15 no Value Ledger | RECLASSIFIED / PARTIAL | Creator generation schema already records cost/latency/provider fields. A unified cross-platform usage/cost/quality ledger is still missing. |
| G16 fail-open auth from Cloudflare repo | LEGACY_EVIDENCE_ONLY | Do not transfer this finding to `sakthiai-hitech` without canonical-source evidence. Canonical auth/runtime must continue to be tested fail-closed. |
| G17 prompt injection via legacy `free-research.js` | LEGACY_EVIDENCE_ONLY + GENERAL THREAT | The exact code finding is not canonical evidence. Prompt-injection/adversarial-RAG testing remains a valid security requirement for canonical retrieval/research. |
| G18 no accessibility verification | RECLASSIFIED | Canonical exact-head CI includes accessibility semantics/focus checks. Live browser/mobile accessibility QA remains a runtime/human evidence gate. |
| G19 no cost/quality/automation ledger | PARTIAL | See G15. Keep unified Value Ledger as planned operations capability rather than claim absent telemetry everywhere. |
| G20 Kimi dead scaffolding | LEGACY_ONLY | Not a current canonical defect unless the same dead provider slot is reintroduced in `sakthiai-hitech`. |

## Accepted implementation deltas from Prompt A

### A. Durable agent execution — PR #25

Added source/control-plane foundations:
- serializable execution checkpoints;
- deterministic plan fingerprints;
- stable per-step idempotency keys;
- durable-store interface;
- resumable event cursor IDs;
- fail-closed crash recovery: an in-flight `running` step restores as `blocked` until idempotency/external-effect reconciliation.

Not yet claimed:
- durable database/Redis/Temporal/DBOS/Restate persistence;
- worker lease/fencing;
- real long-running background worker;
- SSE endpoint;
- exactly-once external action execution.

Those require a separately selected runtime/store and live acceptance evidence.

### B. MCP — PR #25

Added a provider-neutral MCP control-plane contract:
- stdio vs Streamable HTTP transport declaration;
- HTTPS enforcement for remote MCP endpoints;
- no inline endpoint credentials;
- secret-reference requirement for credentialed servers;
- tenant-scoping requirement;
- conversion of MCP tool metadata into SakthiAI skill policy;
- unknown/unannotated tool effects fail closed as high-risk external writes;
- destructive tools classify as critical/privileged;
- all generated MCP skill bindings remain disabled until separately reviewed runtime activation.

Not yet claimed:
- MCP wire-protocol client implementation;
- MCP server implementation;
- external MCP connection;
- OAuth/token exchange;
- production connector execution.

## Accepted backlog after reconciliation

P0 before external beta:
1. server-side session/token revocation;
2. malware scanning/quarantine on uploads;
3. live deployed two-tenant isolation/adversarial replay acceptance;
4. exact deployed SHA + readiness/runtime qualification.

P1 platform completion:
1. real durable execution store + worker/checkpoint/resume acceptance;
2. one real local/self-hosted model engine behind Model Fabric;
3. MCP runtime client/server path with one read-only connector first;
4. runtime golden-dataset evaluation for model/RAG/agent outcomes;
5. isolated real-MySQL migration CI;
6. distributed quotas/rate limiting for multi-instance operation;
7. universal release/deploy hard-gate enforcement;
8. cross-platform Value Ledger.

Creator/runtime lane (PR #7; do not modify from PR #25):
1. explicit consent/rights/revocation model for identity/voice/avatar/media assets;
2. retain existing provenance rather than duplicate it;
3. runtime/paid-provider/human quality acceptance remains separately gated.

## Rejected/deferred from the audit

- Do not treat Cloudflare-repo findings as canonical defects without re-verification.
- Do not revive the legacy repo as a second implementation lane.
- Do not implement A2A before basic MCP/tool interoperability is working and there is a real external-agent federation use case.
- Do not claim long-form single-shot generative video as a release target; retain shot/scene generation plus deterministic assembly.
- Do not activate paid media/frontier providers merely to prove architecture.

## Current evidence statement

The Claude Prompt-A audit was useful as a historical/evidence review, but it mixed legacy and canonical source evidence in several downstream findings after correctly identifying the conflict. This reconciliation preserves the valid risk signals while preventing stale Cloudflare evidence from being promoted into current `sakthiai-hitech` truth.
