# Provider Gateway

`chat.send -> evidence retrieval -> Capability Router (server/model-fabric routeModel) -> Provider Gateway (server/gateway) -> adapter -> normalised result -> grounding`

The gateway is the only chat-model invocation boundary. `routers.ts` imports `getProviderGateway()` and nothing provider-specific; `server/_core/llm.ts` no longer contains a client (only shared types and the retryable-status set). `server/gateway/boundary.test.ts` and `scripts/validate-grounding-answer-contract.mjs` enforce this.

## Policy (all deny-by-default)
- Local/self-hosted endpoint: only when `LOCAL_LLM_API_URL` + `LOCAL_LLM_MODEL` are set. Ranked ahead of every external provider (`preferLocal`).
- External provider (the existing `LLM_API_URL` / `LLM_MODEL` / `LLM_API_KEY`): unusable until `GATEWAY_ALLOW_EXTERNAL=true`. **Deployment note:** an existing deployment that relied on `LLM_API_URL` alone will now return `MODEL_UNAVAILABLE` (evidence preserved) until the owner sets the flags below.
- Metered external (default `LLM_BILLING_MODE=metered_api`): also needs `GATEWAY_ALLOW_METERED=true`, `GATEWAY_BUDGET_STORE=memory` and at least one limit. Anything unverifiable (no store, no limits, store/policy error, cost ceiling without configured rates) denies before the call.
- Subscription-billed external: needs only `GATEWAY_ALLOW_EXTERNAL=true`.
- 401/403 and other 4xx are terminal: no retry, no fallback, no circuit-breaker penalty. Timeouts, network errors, 429, 5xx, malformed and empty responses are provider-health failures: bounded retry (adapter), breaker accounting, fallback to the next policy-eligible provider (each provider tried at most once per request).

## Runtime states
`disabled | invalid_configuration | configured_unverified | reachable_compatible | unhealthy`. `reachable_compatible` is only set after a successful probe or real call; a catalog entry or configuration alone is never a qualification. `SELF_HOST_RUNTIME_NOT_LIVE_QUALIFIED`: the self-hosted path is tested only against deterministic fake OpenAI-compatible servers.

## Known limitations
- `SINGLE_INSTANCE_LIMITATION`: circuit-breaker state and the budget store are in-memory per process.
- `PERSISTENT_MULTI_INSTANCE_ENFORCEMENT_NOT_IMPLEMENTED`: the budget store interface is ready for a shared/DB-backed implementation (atomic reserve); none exists yet, and per-workspace policy currently comes from environment defaults (`WorkspacePolicyResolver` is the seam).
- Token usage is provider-reported when present, otherwise labelled `estimated`; cost is computed only from configured rates.
