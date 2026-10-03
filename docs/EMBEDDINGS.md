# Embedding gateway

Provider-neutral, local-first. Speaks the OpenAI-compatible `POST {base}/v1/embeddings` protocol (Ollama, vLLM and llama.cpp `--embedding` expose it; Ollama's native `/api/embed` is NOT supported).

- `LOCAL_EMBEDDING_API_URL` + `LOCAL_EMBEDDING_MODEL` (+ optional `LOCAL_EMBEDDING_DIMENSIONS`, `LOCAL_EMBEDDING_API_KEY`) configure the self-hosted path.
- `EMBEDDING_API_URL` (+ `EMBEDDING_MODEL`, `EMBEDDING_API_KEY`) configures an external provider. **Owner action:** it is now used only if `EMBEDDING_ALLOW_EXTERNAL=true`, because chunk text would leave the platform. Previously configuring the URL was enough.
- Order: local first; external only as an opt-in fallback for provider-health failures (timeouts, 429, 5xx). 401/403, bad requests and bad vectors are terminal.
- Validation: non-empty array of finite numbers, not all-zero, at most 8192 dims; configured dimension enforced, otherwise learned from the first valid vector and enforced afterwards.
- Timeout (`EMBEDDING_TIMEOUT_MS`), bounded jittered retry (`EMBEDDING_MAX_ATTEMPTS`), per-provider circuit breaker.
- Degradation: any failure returns "no vector" and retrieval runs lexically (Tamil, English and mixed-script lexical retrieval do not depend on embeddings). Tenant scoping happens in SQL before ranking and is unaffected.
- Model safety: a chunk's vector is compared semantically only if it was produced by the same model as the query embedding; otherwise that chunk is scored lexically. After changing the embedding model, re-embed documents to regain semantic scoring.
- Status: `embeddingStatus()` reports `verified: false`; there is no automatic live probe. Verified only against an in-process fake transport; no real embedding server was run.

## Retrieval candidate strategy (DB-first)

`db.searchChunks` -> `server/retrievalStore.ts`. All candidate queries filter by workspace in SQL (chunk and document) before ranking: (1) lexical rows via `documentChunks.searchText` (normalised content, maintained at ingestion; ordered in SQL by matched-term count then id, top 200), (2) legacy rows with `searchText IS NULL` (capped 500, vanishes after `pnpm db:backfill-search-text`), (3) with embeddings: same-model embedded rows, newest first, capped (default 1000). Ranking is the unchanged deterministic scorer (ties by chunk id). Apply migration 0006 first. Limits: `RETRIEVAL_LEXICAL_CANDIDATES`, `RETRIEVAL_LEGACY_CANDIDATES`, `RETRIEVAL_SEMANTIC_SCAN_LIMIT`.
