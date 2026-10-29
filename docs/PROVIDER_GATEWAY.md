# Provider Gateway

`chat.send -> evidence retrieval -> Capability Router (server/model-fabric routeModel) -> Provider Gateway (server/gateway) -> adapter -> normalised result -> grounding`

The gateway is the only chat-model invocation boundary. `routers.ts` imports `getProviderGateway()` and nothing provider-specific; `server/_core/llm.ts` no longer contains a client (only shared types and the retryable-status set). `server/gateway/boundary.test.ts` and `scripts/validate-grounding-answer-contract.mjs` enforce this.

## Policy (all deny-by-default)
- Local/self-hosted endpoint: only when `LOCAL_LLM_API_URL` + `LOCAL_LLM_MODEL` are set. Ranked ahead of every external provider (`preferLocal`).
  - The local slot is exempt from the external/metered flags and the spend budget, so it must really be your own compute. Rules (fail closed, evaluated on the parsed URL host; decimal/hex/octal IPv4, IPv6, IPv4-mapped IPv6, trailing dots and `user@` tricks are normalised):
    - **Loopback** (`localhost`, `127.0.0.0/8`, `::1`) is accepted with no extra configuration, over http or https. This is the normal Ollama / vLLM / llama.cpp-on-this-machine case.
    - **Private-network** targets (RFC 1918, `100.64/10`, `fc00::/7`, single-label names, `.local/.internal/.lan/.home.arpa/.svc/.cluster.local/.localdomain/.localhost`) are accepted **only if the exact host is listed in `LOCAL_LLM_ALLOWED_HOSTS`** (comma-separated; no wildcards, CIDR, ports or schemes). A host given by **name** is resolved at connection time and the call is refused unless every resolved address is loopback or private. The check runs inside the socket's own lookup (`gateway/pinnedFetch.ts`), on the address that is dialled, so there is no second resolution for a rebinding name to win; an early pre-request check gives the same refusal as a cheap first line.
    - **Link-local and cloud-metadata destinations are never allowed, with no allowlist or override**: `169.254.0.0/16` (including `169.254.169.254`), `fe80::/10`, `fd00:ec2::/32`, `100.100.100.200`, the names `metadata`, `instance-data`, `metadata.google.internal`, `metadata.goog` and similar, and the same addresses written as IPv4-mapped, NAT64 (`64:ff9b::/96`), 6to4 or IPv4-compatible IPv6 or as decimal/hex/octal IPv4. This applies to the chat and the embedding local slots. (Earlier revisions classed `169.254/16` and `fe80::/10` as allowlistable private ranges.)
    - **Anything public is refused, whatever the scheme**: public IP literals, `0.0.0.0`, ordinary DNS names (including look-alikes such as `localhost.example.com` or `127.0.0.1.nip.io`), and known hosted-provider domains (Sarvam, Google APIs, OpenAI, Anthropic, Mistral, Groq, OpenRouter, Together, DeepSeek, Cohere, xAI, Perplexity, Fireworks, Moonshot, Azure OpenAI). There is **no override**: `LOCAL_LLM_ALLOW_PUBLIC_HOST` is no longer honoured (it was removed because it let an operator remove policy and budget protections silently). A hosted or internet-reachable model is configured as the external binding (`LLM_*`) where `GATEWAY_ALLOW_EXTERNAL`, `GATEWAY_ALLOW_METERED` and the budget apply. An own-hosted model behind a public domain therefore needs that path too.
    - The local binding **never follows redirects** (`redirect: "error"`), so an endpoint cannot make the gateway re-send a prompt to another destination.
    - Refusal reasons in the runtime status never include the configured host.
    - Residual: an operator who lists a private host asserts that it is theirs; the policy limits where the gateway may connect, not what a listed host does with the prompt. The pinned transport speaks HTTP/1.1 over `node:http(s)` without proxy support (the global `fetch` is used only for external bindings); only string request bodies are supported. Redirects are refused for every binding and profile (see below).
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

## Shared (multi-instance) policy, budget and breaker state

Set `GATEWAY_STATE_STORE=mysql` (requires `DATABASE_URL` and migration `0005_provider_policy_runtime`) to move state into the application database:

- `providerWorkspacePolicies`: per-workspace `externalEnabled`, `meteredEnabled` and daily limits. **No row = external denied.** A corrupt row = denied. `GATEWAY_ALLOW_EXTERNAL`/`GATEWAY_ALLOW_METERED` remain the global ceiling; a workspace row can only narrow, never widen, them. In this mode `GATEWAY_EXTERNAL_MAX_*` env defaults are ignored; limits come from the row.
- `providerUsageWindows` / `providerUsageHolds`: UTC-day counters. `reserve` is one conditional `UPDATE` (atomic under concurrent instances); `commit`/`release` apply exactly once. Stale holds from crashed instances stay counted (conservative).
- `providerBreakerStates`: transitions are compare-and-set, so only one instance wins a HALF_OPEN probe.
- Failure policy: if shared state is unreadable, external providers are denied (fail closed); the self-hosted provider keeps working (no spend, no data egress).
- Writing policy: `upsertWorkspaceProviderPolicy(getDb, workspaceId, {...})` (validated). There is no end-user API; enabling spend is an operator action.
- Verified locally against MariaDB 10.11 only (`pnpm test:mysql`); MySQL 8 and any live database remain unverified.


## Endpoint profiles (external provider only)
`LLM_ENDPOINT_PROFILE` (operator configuration only) selects how the single external binding is called:

| Profile | Host (exact match) | Path | Notes |
|---|---|---|---|
| `openai-v1` (default, also when unset) | operator-supplied | `{base}/v1/chat/completions` | Historical behaviour, unchanged |
| `gemini-openai` | `generativelanguage.googleapis.com` | `/v1beta/openai/chat/completions` | `LLM_API_URL` must be the origin only |
| `sarvam-chat` | `api.sarvam.ai` | `/v1/chat/completions` | `LLM_API_URL` must be the origin only |

Pinned profiles refuse (binding becomes `invalid_configuration`, nothing is called) any non-https URL, other host, lookalike host, userinfo, non-default port, path, query or fragment; the request path is fixed in the adapter; requests use `redirect: "error"` so a credential-bearing call can never be forwarded to another host. An unrecognised profile name is refused rather than defaulted. The local binding takes no profile. Budget, policy, breaker and retry behaviour are unchanged. Compatibility with the live providers is **documentation-level only** until an owner-approved probe; `ProviderRuntimeStatus.endpointProfile` and the provenance record carry the profile label, never the URL.

## Redirects (all bindings)
No chat or embedding request follows an HTTP redirect (`redirect: "error"`), for the local binding, the external default profile and the pinned profiles alike. A redirect is reported as a network failure (retryable like any network failure, never sent on). Reason: reproduced on `0a48dc3`, the default external profile followed a 307 and re-sent the full prompt to the redirect target (the `Authorization` header was dropped cross-origin by the HTTP client, but the body was not), which is also a server-side request to any address the response names. An operator whose provider genuinely redirects must configure the final URL.

## Provenance of a model call
Each returned call yields a credential-free `ModelCallMeta` (provider id, model id, profile, local/hosted class, endpoint profile label, config family, usage and gateway-computed cost, latency, per-provider attempts, `fallbackOccurred`, invocation time, request id as correlation id, and `verification: "gateway_reported"`). It states what the gateway was configured with and what it returned; the provider did not attest it. Consumers must show UNVERIFIED when it is absent.

## Manual provider switch and fallback status
- There is exactly one external binding, so there is **no external-to-external fallback**; the only automatic fallback is local-first to external (each provider tried once per request), and it respects policy and budget. Authentication and caller errors never fall through.
- Bounded external-to-external fallback was evaluated and **deferred**: it needs a second external binding, a catalog profile per binding, per-provider budget counters and an idempotency decision for requests that may already have been billed. None is implemented; no flag exists.
- To switch providers: set a different `LLM_ENDPOINT_PROFILE`/`LLM_API_URL`/`LLM_MODEL`/`LLM_API_KEY`/rates and restart. The provider id stays `external-openai-compatible`. Budget counters are per workspace per UTC day (not per provider), so request/token counts carry across a switch, and the **cost counter would silently mix currency units** (e.g. INR then USD) if you switch mid-day: switch at a UTC day boundary, or accept that the cost ceiling is unreliable for that day. In a durable store the circuit-breaker state is also keyed by provider id and carries over until its cooldown. Use provenance (`modelId`, `endpointProfile`) to tell calls apart, and re-check the rates and daily ceilings at the same time.
