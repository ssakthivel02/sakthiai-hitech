# Budget ceilings: what is enforced, what is not

| Control | Mechanism | Enforced by | Notes |
|---|---|---|---|
| Per-request output | `GATEWAY_MAX_OUTPUT_TOKENS` (default 1024, max 32768) | Gateway; sent as `max_tokens` | Also drives the worst-case reservation |
| Daily request / token / cost ceilings | `GATEWAY_EXTERNAL_MAX_REQUESTS_PER_DAY`, `_TOKENS_PER_DAY`, `_COST_PER_DAY` | Budget gate: atomic reserve before the call, commit after | UTC day. A cost ceiling needs all three rate variables, else it fails closed |
| Monthly ceiling | **Not a gateway feature.** | Provider-side spend cap / budget alert; or ceiling x days | Daily x 30 is the arithmetic upper bound only while the store is durable |
| Durable enforcement across restarts and instances | `GATEWAY_STATE_STORE=mysql` + migration `0005` | MySQL store | `memory` resets on restart: the real spend bound is then (daily cap x restarts) |
| Counter scope | Per workspace per UTC day, not per provider | Budget store | Switching provider/currency mid-day mixes units in the cost counter |
| Per-workspace controls | `providerWorkspacePolicies` rows (`externalEnabled`, `meteredEnabled`, limits) | MySQL store only | A row can only narrow the global ceiling. No row = external denied. Written by an operator, there is no end-user API |
| Owner-only override | Operator writes the policy row / changes env | Operator | No in-product override UI exists |
| Denial behaviour | `budget_denied` / `policy_denied` | Gateway | Task fails with `BUDGET_DENIED`/`POLICY_DENIED`, no retry, no fallback to another external provider |
| Telemetry | Gateway log entry per call (no prompt, no key), `attempts[]`, usage with source (`provider_reported` / `estimated`), and the credential-free `ModelCallMeta` provenance record (`server/gateway/provenance.ts`) | Gateway + trace | Cost is configured-rate x reported tokens: an estimate, not an invoice |

Worked example (illustrative, uses the template rates): 200 requests/day x (about 1,500 prompt + 600 completion tokens) is about 0.3 M prompt + 0.12 M completion tokens, so roughly INR 4.5 + 7.2 = INR 12 per day at Sarvam 105B rates, well inside the INR 100/day ceiling. The first ceiling to bind will normally be requests or tokens, not cost.
