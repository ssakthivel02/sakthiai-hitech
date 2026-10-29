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
| `artifacts.get` | `workspaceId`, `artifactId` | Full artifact with citations and `fileReferences` (re-resolved on every read: `available` = `documentId`, `filename`, `mimeType`, `projectId`, `pageCount`, `uploadedAt`, `addedByUserId`, `linkedAt`; `unavailable` = file no longer in this workspace, name withheld). A cross-tenant id is `NOT_FOUND`, indistinguishable from a missing one |
| `artifacts.update` | `workspaceId`, `artifactId`, optional `title` (max 400, sanitized to 180), optional `projectId` (`null` removes it from its project); at least one required | Updated artifact. Only title and project can change; content, evidence and provenance cannot. A rename re-indexes search. Only the member who saved it or a workspace owner may change it (`FORBIDDEN`); `BAD_REQUEST` (nothing to change, empty title), `FORBIDDEN` (project not in this workspace), `NOT_FOUND` |
| `artifacts.delete` | `workspaceId`, `artifactId` | `{ deleted: true }`. Removes the artifact and its file links in one transaction (chat and files are untouched; the answer can be saved again). Saver or workspace owner only; a second delete is `NOT_FOUND` |
| `artifacts.attachFile` | `workspaceId`, `artifactId`, `documentId` | `{ reference, created }`. Links an existing file of the SAME workspace by id; nothing from the file is copied. Idempotent (`created: false`). Saver or workspace owner only (`FORBIDDEN`); a file from another workspace or a missing one is `NOT_FOUND` ("File not found"); more than 20 links is `PRECONDITION_FAILED` |
| `artifacts.detachFile` | `workspaceId`, `artifactId`, `documentId` | `{ detached: boolean }`. Removes the link only, never the file; also clears links whose file is unavailable. Saver or workspace owner only |
| `search.workspace` | `workspaceId`, `query` (1-500), optional `limit` (max 25) | `{ query, lowInformation, artifacts, documents }`: two separately ranked groups, each hit with a snippet and match method |

Canonical citation fields are `documentId`, `filename`, `mimeType`, `page` when genuinely available, `section`, `paragraph`, `chunkId`, `excerpt`, `sourceStart`, `sourceEnd`, `retrievalMethod`, and `retrievalScore`. DOCX citations do not contain invented page numbers.

HTTP endpoints are `GET /healthz` for process liveness and `GET /readyz` for dependency readiness. Every response has an `x-request-id`; clients may supply one for correlation. Errors use the existing tRPC error envelope and preserve explicit `FORBIDDEN`, `BAD_REQUEST`, `CONFLICT`, and `INTERNAL_SERVER_ERROR` semantics.
