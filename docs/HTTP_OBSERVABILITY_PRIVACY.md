# SakthiAI HTTP observability privacy boundary

This document defines the minimum request telemetry permitted for the SakthiAI HI-TECH runtime.

## Allowed structured request fields

The HTTP request event may contain only:

- `event`
- `requestId`
- `method`
- `routeClass`
- `status`
- `latencyMs`

Do not add request or response bodies, cookies, authorization headers, access tokens, email addresses, user IDs, workspace IDs, project IDs, document names, prompts, retrieved content, generated content, storage object keys, provider credentials, database identifiers, or raw URLs/query strings to this event.

## Route minimization

Operational endpoints (`/healthz`, `/readyz`, `/releasez`) remain exact because they contain no tenant data and are required for runtime evidence.

All other request paths are reduced to low-cardinality route classes such as `/api/trpc`, `/oauth/*`, `/storage/*`, `/api/*`, `/assets/*`, or `/app`. This deliberately sacrifices per-resource path logging to reduce accidental persistence of user/resource identifiers.

## Request identifiers

Caller-supplied `x-request-id` values are optional. They are stripped of control characters and capped at 128 characters. Missing or empty values use a server-generated UUID.

A request ID is correlation metadata, not an authentication or authorization credential. It must never be trusted for identity or access control.

## Evidence boundary

This control reduces sensitive-data exposure in the built-in HTTP request event. It does not prove provider log-retention configuration, external SIEM policy, incident response, deletion SLAs, or end-to-end privacy compliance. Those remain runtime/operational acceptance items.
