# Sentinel local development qualification

Production remains HOLD. This document describes development evidence, not competition eligibility, blind accuracy or live hosted acceptance.

## Recovered changes (20 November 2026)

The two original Drive packages were checksum-verified and applied sequentially to the existing Sentinel lane. Their source blob progression was `9a95d611b99e` → `b13c96fdf810` → `d07b27f0cfd2`. Original isolated reruns passed 16/16 and 30/30. Package ZIP SHA-256:

- Contract: `732f2a53c156a9f7bb7a8f156bc45e9fa7830ba52e1bb673ca9f2d60a65ccd4f`
- Retry: `0e7745bc1be427e2376feccfff5fcb2cf2ef404dcc2c8a4081c65f11bc7de7b9`

Further regressions reject inherited final labels, malformed hypothesis references, non-finite confidence, malformed contradiction members and invalid next steps. The prompt now provides generic valid examples of both diagnosis and abstention; no incident-specific answer is supplied. Semantic evidence/tenant checks remain mandatory.

## Genuine local-model evidence

Qwen3-4B-Instruct-2507 Q4_K_M, quantized by Unsloth (Apache-2.0 metadata), revision `a06e946bb6b655725eafa393f4a9745d460374c9`, weight SHA-256 `3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597`. Runtime: official MIT llama.cpp `b12110` / `cd959bae9`, archive SHA-256 `368227edcc229be5f9bed16a2223d79b5e41d0ac2e19bcf5825e82291c060e55`.

Two disclosed runs reused the previously authored checkout development case. Neither is held-out or independent evaluation. First run, with recovered packages/hardening and memory fixtures: 5 model calls, 4 tools, 172.680s, safe under-diagnosis/ABSTAIN despite available disk-full evidence. This failure is retained.

Second run at commit `d1479befa1ce19da1d0b029d1bf77fcc92d66a6e`, after adding a generic diagnosis example: real MySQL 8.0.46 task/investigation stores, real TaskWorker and gateway, local model, synthetic diagnostic transport. It completed in 161.623s, 5 model calls and 4 read-only tools, with DISK_FULL / DIAGNOSIS / verified=true. It cited records from logs and metrics, retained 5 durable reservations and verified the 21-event trace chain. No format retries, denied tools or remediation execution occurred. The scratch database was dropped.

`verified` means structurally evidence-backed under the current verifier, not independent semantic proof. The two runs differ in prompt and storage/context; do not attribute improvement to one change or compute a generalization success rate. Four calls used the configured tool budget, so the final stop reason is BUDGET_EXHAUSTED even though the final diagnosis was accepted.

Synthetic tools are not live MCP, and SQL uses the old PR #34 migration composition. The 0021 collision with current integration #63 remains unresolved. No managed DB history was inspected or renumbered; no new migration was added.

## Optional request-scoped JSON-object mode

Plain requests are unchanged. For an endpoint you have verified supports OpenAI-compatible JSON-object mode, set `LOCAL_LLM_JSON_MODE=true`. A caller must separately request `responseFormat: "json_object"`; Sentinel does so only with `SENTINEL_JSON_MODE=true`.

The gateway requires the catalog's structured_output capability and endpoint opt-in, then sends `response_format: {type: "json_object"}`. Missing opt-in sends no request; invalid formats and backend rejection fail closed. There is no silent plain-text downgrade. The external environment binding currently has no JSON-mode opt-in: do not assume arbitrary hosted compatibility.

This is JSON-object mode, not arbitrary JSON Schema enforcement. The unchanged Sentinel parser, broker, ledger, verifier, tenant policy, spend controls and durable call budget still validate results. No server-wide grammar is required. The development diagnosis above used plain mode; a separate simple runtime JSON control succeeded, not an additional incident test.

## Reproduction and remaining boundaries

Use the project-pinned package manager: `corepack pnpm install --frozen-lockfile`. The environment's unpinned pnpm 11 ignored this repository's package overrides; no lockfile was regenerated. Run `corepack pnpm check` and the relevant Vitest suites. MySQL tests must use TEST_DATABASE_URL pointing to a disposable loopback server with MYSQL_REQUIRED=1; the harness creates/drops its own databases and refuses managed hosts.

The accompanying private evidence bundle contains the two frozen inputs, exact source patch/commit identifiers, harnesses, all raw model requests/replies, SQL task checkpoint, trace, hardware, model/license metadata and actual command/test logs. It contains no weights, binaries, credentials or holdout answers. The workspace has a 2-core/8-GiB cgroup limit; large VFS Docker images can exhaust its 8-GB filesystem. The initial full test log failed on ENOSPC and is preserved, not passed off as green. A smaller native MySQL runtime was recovered from verified official image layers for these disposable tests; it is not a deployment recommendation.

Independent frozen evaluation, separate unfamiliar development cases, human baseline, real connector/OIDC qualification, canonical migration reconciliation, model repeatability and hosted demo remain pending. Do not access sealed answers while modifying policy. The available Drive folder did not contain the earlier public Dev2 ZIP; it was not regenerated, and unrelated private search results were not opened.

## Optional local llama-compatible response schemas

The existing gateway can forward a caller-supplied `responseSchema` only with `responseFormat: "json_object"`, `LOCAL_LLM_JSON_MODE=true` and a separately verified endpoint opted in with `LOCAL_LLM_LLAMA_JSON_SCHEMA=true`. This uses the native llama-compatible `response_format: {type: "json_object", schema: ...}` extension; it is not inferred from the catalog capability and is not enabled for external bindings. Default requests and plain JSON mode retain their historical wire format. Sentinel does not request schemas by default.

The transport envelope accepts only plain JSON objects, at most32KiB UTF-8,maximum depth16 and2048nodes, with local fragment references only. Cycles, accessors, non-JSON values and external references are refused before HTTP. These are bounded transport checks, not full JSON Schema validation or a promise that every keyword is supported. Backend rejection remains terminal; the gateway never retries as unconstrained JSON. Existing per-request limits, routing, network policy and downstream parser/broker/verifier remain authoritative. Schema conformance alone does not establish correct diagnosis, useful tool choice or independent source evidence.

Qualification on23November2026: the pre-implementation HTTP characterization produced6failures/2passes across8cases; after the change,11new boundary tests and118focused tests passed. Full disposable-MySQL8.0.46 regression:1978/1978PASS,193files,zero skips,200.16s. TypeScript,build,neutrality and default-off smoke passed (healthz200/readyz503; not hosted readiness). A separate native two-call conflicting-prompt probe observed enum restriction, not complete dialect coverage or improved incident accuracy. Actual gateway-to-model schema qualification and exact-head CI are separately recorded in Issue30/PR34 evidence. Production remains HOLD.

## Final-only outcome guidance (23 November2026)

A frozen default-argument grammar experiment exposed a contract mismatch: the engine/parser permit an evidence-backed final diagnosis at an exhausted tool/step boundary, but the model instruction said `force_final` required abstention. Its v1experimental decoder also excluded diagnosis whenever that flag was true. Two selected PUBLIC runs read10diagnostics and then abstained at that boundary; this does not establish that their correct outcomes should have been diagnoses. All v1outcomes were preserved before repair.

`force_final` now clearly requires a FINAL response. The prompt budget includes `structural_final_outcomes`: DIAGNOSIS/ABSTAIN when the existing structural minimum is met, ABSTAIN otherwise. These are shape candidates, not evidence relevance, source independence or diagnosis approval. Existing parser, broker, verifier, strict ledger, timestamps, tenant controls and call/token/retry limits remain unchanged; another tool call is still unavailable at the cap. Request schemas remain default-off.

Two new state-guidance regressions failed before the change and pass after it (7existing controls also pass). Focused71PASS;full disposable-MySQL8.0.46 regression1980/1980PASS,193files,zero skips,201.45s. TypeScript/build/neutrality/default-off smoke PASS (healthz200/readyz503;not hosted readiness). Exact-head CI and genuine-model qualification are separately recorded in Issue30/PR34. The next frozen experiment must allow both final outcomes at the cap when structural evidence permits; it must never force a diagnosis, add permissions or raise budgets. Semantic correctness/source authenticity and other release gates remain open.
