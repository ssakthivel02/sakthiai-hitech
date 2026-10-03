# Governed read-only MCP connector

Scope: the first real MCP runtime, deliberately **read-only**. Streamable-HTTP transport only (no stdio, so no process spawning); methods used are `initialize`, `tools/list`, `tools/call`, `resources/list`, `resources/read`.

Governance
- Connectors are workspace-owned (`mcpConnectors`, migration 0009), created **disabled**; only workspace *owners* register/enable/remove; members may list, discover, read resources and call permitted tools. Another workspace's connector id is NOT_FOUND.
- The endpoint is configuration, never model input. `MCP_ALLOWED_ENDPOINTS` (comma-separated exact origins) must contain the connector's origin at registration **and at every call** (removing it disables the connector). https required (http only for loopback when `MCP_ALLOW_LOOPBACK_HTTP=true`); no credentials, query or fragment; redirects are never followed; resolved addresses may not be link-local/metadata (never) or private (unless `MCP_ALLOW_PRIVATE_NETWORK=true`).
- A tool is callable only if the server declares `readOnlyHint: true`, does not declare `destructiveHint`, its name does not look like a mutation (create/delete/update/write/send/run/exec/deploy/push/pay/set/...), and the connector's optional tool allowlist contains it. Everything else is DENIED **before** any `tools/call` is sent. Resources must appear in the server's `resources/list`; binary resources are refused.
- Arguments are validated against the server-declared `inputSchema` subset (type/required/enum/length/range/items/additionalProperties); tool entries with malformed schemas are dropped and counted.
- Limits: per-connector timeout (500 ms-30 s) and response bytes (1 KiB-2 MB, streamed and aborted), model-facing text capped at 32,000 characters (truncation is flagged), arguments capped at 16 KB.
- Secrets: `secretRef` names a server-side secret (`MCP_SECRET_<REF>`); the value is sent only as the bearer, never stored, returned, logged or audited, and is redacted (plus common credential shapes) from tool output, descriptions and resource names.
- Provenance on every result: connector id/name, server name/version, endpoint origin, tool or resource, retrieval time, bytes, truncation. Every operation (including denials) writes `mcpConnectorAudit`; if the audit row cannot be written the result is withheld.
Not claimed: any real MCP server, OAuth-protected servers, exposure to the chat/agent loop.
