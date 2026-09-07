# Sakthi AI Nexus — W25 Recovery Runtime

This workspace is a controlled rebuild of the previously proven W25 functional slice. It deliberately excludes the broader website and Android work.

## Included vertical slice

- Authenticated Manus OAuth workspace
- Per-user workspace ownership and tenant-scoped authorization
- English Web Chat and Tamil Chat
- Projects
- Private file upload via Manus storage
- PDF, DOCX, and text extraction
- Keyword-first retrieval augmented generation (RAG)
- Durable conversations and messages
- Citation metadata: filename, documentId, page when available, and excerpt
- Cross-user denial at every workspace-scoped procedure

## Source structure

`client/` contains the focused UI. `server/routers.ts` is the tRPC contract. `server/db.ts` contains all tenant-aware data helpers. `drizzle/schema.ts` and `drizzle/0001_w25_recovery.sql` define the durable data model. `server/recovery.security.test.ts` covers the access-control invariants.

## Local setup

```bash
cp .env.example .env
pnpm install
pnpm db:push
pnpm dev
```

The platform injects the real values for `DATABASE_URL`, Manus OAuth, storage, and LLM access. Never commit `.env` or secrets.

## Validation

```bash
pnpm check
pnpm test
pnpm build
```

The build creates `dist/public` and a bundled backend. The managed WebDev runtime serves the preview and backend API from the same project deployment.

## Canonical-base note

This recovery workspace is based on the W25 evidence available in the Sakthi AI Nexus project context and the standard full-stack scaffold. The prior unrecoverable WebDev project and Release 001 static archive were not reopened or treated as authority.
