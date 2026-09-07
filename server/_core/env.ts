export const ENV = {
  appId: process.env.VITE_APP_ID ?? "sakthiai",
  cookieSecret: process.env.JWT_SECRET ?? "",
  databaseUrl: process.env.DATABASE_URL ?? "",
  oAuthServerUrl: process.env.OAUTH_SERVER_URL ?? "",
  ownerOpenId: process.env.OWNER_OPEN_ID ?? "",
  isProduction: process.env.NODE_ENV === "production",

  // Provider-neutral OpenAI-compatible LLM endpoint.
  llmApiUrl: process.env.LLM_API_URL ?? process.env.OPENAI_BASE_URL ?? "",
  llmApiKey: process.env.LLM_API_KEY ?? process.env.OPENAI_API_KEY ?? "",
  llmModel: process.env.LLM_MODEL ?? "",

  // Provider-neutral embeddings endpoint.
  embeddingApiUrl: process.env.EMBEDDING_API_URL ?? "",
  embeddingApiKey: process.env.EMBEDDING_API_KEY ?? "",
  embeddingProvider: process.env.EMBEDDING_PROVIDER ?? "",
  embeddingModel: process.env.EMBEDDING_MODEL ?? "",
  embeddingTimeoutMs: Number(process.env.EMBEDDING_TIMEOUT_MS ?? 8000),

  // Generic S3-compatible object storage. Works with AWS S3 and compatible
  // self-hosted/object-storage services by setting STORAGE_ENDPOINT.
  storageEndpoint: process.env.STORAGE_ENDPOINT ?? "",
  storageRegion: process.env.STORAGE_REGION ?? "auto",
  storageBucket: process.env.STORAGE_BUCKET ?? "",
  storageAccessKeyId: process.env.STORAGE_ACCESS_KEY_ID ?? "",
  storageSecretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY ?? "",
  storageForcePathStyle: process.env.STORAGE_FORCE_PATH_STYLE === "true",
};
