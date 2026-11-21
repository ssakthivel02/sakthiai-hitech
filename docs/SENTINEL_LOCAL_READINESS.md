# Local Sentinel model preflight

Operator-only development command. Does not enable Sentinel, admit production work, change HTTP readiness, execute diagnostics, contact an external provider, or prove incident accuracy. Production HOLD and independent semantic/provenance gates remain.

The 4B CPU configuration previously timed out on its first cold request at60s. Later requests reused the system-prompt KV cache. This helper tests an explicit preparation sequence rather than hiding a cold failure or extending request deadlines.

```
LOCAL_LLM_API_URL=http://127.0.0.1:8897/v1 \
LOCAL_LLM_MODEL=Qwen3-4B-Instruct-2507-Q4_K_M \
LOCAL_LLM_JSON_MODE=true SENTINEL_JSON_MODE=true \
corepack pnpm exec tsx scripts/sentinel-local-readiness.ts /workspace/NEW_READINESS_DIRECTORY
```

The parent directory must exist. The command exclusively creates the evidence directory and refuses to mix a new run with old inputs/events. Endpoint must be credential-free loopback; an optional LOCAL_LLM_API_KEY header stays private and is never written in metadata. External-provider environment settings are ignored; external/metered policy stays false. Gateway state is process-local memory, not managed SQL. Synthetic workspace7 is used unless a positive SENTINEL_READINESS_WORKSPACE_ID is supplied.

Two logical requests maximum, each with the existing gateway60s total deadline and one HTTP attempt:

1. Prime: same production Sentinel system prompt, a neutral no-incident/no-tools view and maxOutputTokens1. The intentionally incomplete response is retained but never qualifies readiness.
2. Qualify: same messages with maxOutputTokens256. Must return a valid FINAL/ABSTAIN/INCONCLUSIVE with no citations, contradictions or invented hypotheses. Existing parser/verifier reject unsafe claims, unknown references and output requiring sanitation. A CALL is refused; no diagnostic tool is available or executed.

Only a self_hosted/local_compute outcome from the configured local provider can qualify. Failure stops without retrying; evidence records actual request/reply, usage and elapsed time. JSON-object mode requires both the endpoint flag and explicit Sentinel request flag as usual. Plain mode remains available and unchanged.

The result scope is LOCAL_MODEL_CONTRACT_ONLY. ready=true means a neutral safe-abstention response was observed after priming, not that the app/worker/connector is operational or a diagnosis is correct. No global readiness flag is written. Successful priming alone is insufficient. Startup time, tokens and subsequent investigation latency must be reported separately. A failed/timed-out stage remains a failed preflight even if its abandoned work warmed the runtime.

Rerun after model process restart, prompt/taxonomy/config change or cache eviction. This is an operator sequence, not a persistent cache guarantee, request admission lock, health daemon or production cold-start fix. A shared/evicting model service can still lose the prefix before an investigation. Do not combine it with a sealed evaluator or reuse it to claim benchmark accuracy. OS file cache and model KV cache are different; label process-restart tests accordingly.

Evidence input/event files contain only a neutral synthetic control, not customer telemetry. The result records the system prompt SHA256, logical call count and total preflight duration; a result exists only after the preflight completed. Retain first attempts and failures. No source/policy/timeouts are changed based on whether a trial passes.

A valid neutral response does not predict permitted target selection. In one recorded2017c3c trial, preflight passed but the first subsequent incident repeatedly invented a log-index target, received scope denials, executed zero backend tools and abstained. The first request messages matched an earlier successful development run, so operational repeatability remains unqualified. Later prompt guidance exposes exact allowed_targets and denied_requests and asks the model to correct or abstain; the broker remains the authority and records denials. This is guidance, not a guarantee of model compliance. Retain both the failed trial and any later tuned result; do not call a same-case retry independent accuracy.
