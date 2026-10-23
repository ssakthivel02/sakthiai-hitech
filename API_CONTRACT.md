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
| `chat.send` | `workspaceId`, optional `conversationId`, message, `language` (`en`/`ta`) | Answer, citations, `grounding` = `GROUNDED_EVIDENCE` (evidence + model answer), `INSUFFICIENT_EVIDENCE` (no usable evidence) or `MODEL_UNAVAILABLE` (evidence found but answer generation failed; citations still returned), latency/request ID |
| `runtime.status` | None | Health/readiness-related dependency status |
| `artifacts.saveFromMessage` | `workspaceId`, `conversationId`, `messageId`, optional `projectId`, optional `title` (no content or citations accepted) | `{ artifact, created }`. Content and citations are copied server-side from the stored assistant message; idempotent per message. `FORBIDDEN` (conversation or project not accessible), `NOT_FOUND` (message), `PRECONDITION_FAILED` (answer not saveable: insufficient evidence, model-unavailable fallback, no citations), `PAYLOAD_TOO_LARGE` |
| `artifacts.list` | `workspaceId`, optional `projectId`, optional `limit` (max 200) | Workspace-scoped artifact summaries, newest first |
| `artifacts.get` | `workspaceId`, `artifactId` | Full artifact with citations; a cross-tenant id is `NOT_FOUND`, indistinguishable from a missing one |
| `search.workspace` | `workspaceId`, `query` (1-500), optional `limit` (max 25) | `{ query, lowInformation, artifacts, documents }`: two separately ranked groups, each hit with a snippet and match method |

Canonical citation fields are `documentId`, `filename`, `mimeType`, `page` when genuinely available, `section`, `paragraph`, `chunkId`, `excerpt`, `sourceStart`, `sourceEnd`, `retrievalMethod`, and `retrievalScore`. DOCX citations do not contain invented page numbers.

HTTP endpoints are `GET /healthz` for process liveness and `GET /readyz` for dependency readiness. Every response has an `x-request-id`; clients may supply one for correlation. Errors use the existing tRPC error envelope and preserve explicit `FORBIDDEN`, `BAD_REQUEST`, `CONFLICT`, and `INTERNAL_SERVER_ERROR` semantics.
