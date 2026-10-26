# Gateway configuration templates (NOT ACTIVE)

These are templates. Nothing here is read by the application; no key is included. Copying values into a real environment (Render, a `.env` file, a secret store) is an owner action that spends money or sends data to a third party.

| File | Purpose |
|---|---|
| `sarvam-preview.env.example` | Hosted Sarvam through the pinned `sarvam-chat` endpoint profile |
| `gemini-preview.env.example` | Hosted Gemini through the pinned `gemini-openai` endpoint profile |
| `local-only.env.example` | Self-hosted OpenAI-compatible runtime (e.g. Ollama/vLLM); external disabled |
| `budget-ceilings.md` | What the gateway can and cannot enforce, and how to read the numbers |

Rules that hold for every template:
- Only ONE external provider can be configured at a time (one external binding). Switching is a manual configuration change plus restart (do it at a UTC day boundary: the cost counter is not per provider); see `docs/PROVIDER_GATEWAY.md` ("Manual provider switch").
- A hosted API must go in the `LLM_*` (external) slot, never in `LOCAL_LLM_*`. The local slot bypasses the external/metered policy and the budget gate and would also mislabel provenance.
- Prices are estimates read from the providers' public pages on 18 Oct 2026 and must be re-checked before activation.
- Model ids are placeholders to confirm against the provider's current model list on the day of activation. The Sarvam chat-completions reference read on 23 Oct 2026 lists `sarvam-105b` (and `sarvam-105b-conversations`); the Sarvam reference page (read 25 Oct 2026) lists `Authorization: Bearer` as required and `api-subscription-key` as optional but is internally inconsistent, and the adapter sends only `Authorization: Bearer`. Confirm in the first owner-approved call; if it is refused with an authentication error the change is a one-line adapter header addition, not a redesign.
