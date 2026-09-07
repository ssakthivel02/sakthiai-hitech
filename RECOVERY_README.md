# Recovery handoff

This is the editable, durable source for `SAI-WEB-RECOVERY-001`. It is intentionally limited to the W25 vertical slice: authenticated workspaces, tenant isolation, projects, private documents, extraction, RAG, citations, and persistent chat.

Run `pnpm install && pnpm check && pnpm test && pnpm build` from this directory. The managed WebDev environment supplies the runtime secrets and database. The preview URL serves both the React UI and `/api/trpc` backend.

The prior WebDev project was confirmed unrecoverable and was not reopened. Release 001 static content was not treated as authority.
