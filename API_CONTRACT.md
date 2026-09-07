# Stable API contract

The web and future Android clients use the same tRPC contracts; no client-specific schemas are introduced.

| Contract | Input | Output / errors |
|---|---|---|
| `auth.me` / `auth.logout` | Session cookie | User or `null`; logout success |
| `workspace.list` / `workspace.ensure` | Authenticated session | Tenant-scoped workspace records |
| `projects.list` / `projects.create` | `workspaceId`, project fields | Workspace-scoped projects; cross-tenant access is `FORBIDDEN` |
| `files.list` | `workspaceId` | Metadata only; private storage remains server-side |
| `files.upload` | `workspaceId`, optional `projectId`, filename, MIME, base64 | Document ID, page count, extracted character count, embedding status, scanner status |
| `chat.history` | `workspaceId`, `conversationId` | Durable messages and canonical citations |
| `chat.send` | `workspaceId`, optional `conversationId`, message, `language` (`en`/`ta`) | Answer, citations, `GROUNDED_EVIDENCE` or `INSUFFICIENT_EVIDENCE`, latency/request ID |
| `runtime.status` | None | Health/readiness-related dependency status |

Canonical citation fields are `documentId`, `filename`, `mimeType`, `page` when genuinely available, `section`, `paragraph`, `chunkId`, `excerpt`, `sourceStart`, `sourceEnd`, `retrievalMethod`, and `retrievalScore`. DOCX citations do not contain invented page numbers.

HTTP endpoints are `GET /healthz` for process liveness and `GET /readyz` for dependency readiness. Every response has an `x-request-id`; clients may supply one for correlation. Errors use the existing tRPC error envelope and preserve explicit `FORBIDDEN`, `BAD_REQUEST`, `CONFLICT`, and `INTERNAL_SERVER_ERROR` semantics.
