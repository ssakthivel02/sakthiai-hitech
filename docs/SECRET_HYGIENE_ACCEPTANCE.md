# Secret Hygiene Acceptance

This control advances Issue #1 `secrets/config hygiene` using repository-level evidence only.

## What is enforced

- runtime `.env` files must not be tracked; `.env.example` is the only permitted `.env*` file;
- documented sensitive values remain empty or explicit placeholders;
- tracked text is scanned for a small set of high-confidence credential signatures;
- a deliberately unsafe fixture must be rejected by CI;
- repository scanning does not grant production approval.

## High-confidence signatures

The guard currently detects private-key blocks, GitHub-style personal/access tokens, OpenAI-style `sk-` secrets, Google API keys and AWS access-key identifiers.

The matcher is intentionally conservative. It is not a substitute for GitHub secret scanning, provider-side leak detection, rotation policy or a managed secret store.

## Runtime boundary

Secrets must remain in approved external secret stores/runtime dashboards. Do not paste production or preview credentials into repository files, PR comments, issue comments, logs or chat transcripts.

## Evidence boundary

A PASS means the current tracked tree satisfies this narrow repository contract. It does **not** prove:

- repository history has never contained a secret;
- previously exposed credentials were rotated;
- GitHub/provider secret scanning is enabled or complete;
- runtime secret-store permissions are correct;
- external logs contain no secrets;
- production security approval.

Historical or suspected exposures must be handled by revocation/rotation at the provider; deleting a value from the current tree is not sufficient.
