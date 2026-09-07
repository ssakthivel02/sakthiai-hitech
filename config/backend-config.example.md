# Backend configuration example (no secrets)

The managed runtime injects these values. Do not place real values in source control.

```text
DATABASE_URL=<managed database connection>
JWT_SECRET=<managed session secret>
OAUTH_SERVER_URL=https://api.manus.im
VITE_APP_ID=<managed app id>
VITE_OAUTH_PORTAL_URL=<managed OAuth portal>
BUILT_IN_FORGE_API_URL=<managed Forge API>
BUILT_IN_FORGE_API_KEY=<managed secret>
OWNER_OPEN_ID=<managed owner id>
OWNER_NAME=<managed owner name>
EMBEDDING_API_URL=<optional OpenAI-compatible embeddings endpoint>
EMBEDDING_API_KEY=<optional embedding provider secret>
EMBEDDING_PROVIDER=<provider label>
EMBEDDING_MODEL=<embedding model identifier>
EMBEDDING_TIMEOUT_MS=8000
```

The checked-in project contains no credentials. See the platform environment configuration for actual values.

If `EMBEDDING_API_URL` is absent or unavailable, semantic retrieval is reported as unavailable and lexical retrieval remains active. No embedding or score is fabricated. Malware scanning is not included; the API reports `SCANNER_NOT_CONFIGURED`.
