const allowLegacyForgeRuntime = process.env.ALLOW_LEGACY_FORGE_RUNTIME === "true";

export const ENV = {
  appId: process.env.VITE_APP_ID ?? "sakthiai",
  cookieSecret: process.env.JWT_SECRET ?? "",
  databaseUrl: process.env.DATABASE_URL ?? "",
  ownerOpenId: process.env.OWNER_OPEN_ID ?? "",
  isProduction: process.env.NODE_ENV === "production",

  // Provider-neutral OpenID Connect / OAuth 2.0 authentication.
  oidcAuthorizationUrl: process.env.OIDC_AUTHORIZATION_URL ?? "",
  oidcTokenUrl: process.env.OIDC_TOKEN_URL ?? "",
  oidcUserInfoUrl: process.env.OIDC_USERINFO_URL ?? "",
  oidcClientId: process.env.OIDC_CLIENT_ID ?? process.env.VITE_APP_ID ?? "sakthiai",
  oidcClientSecret: process.env.OIDC_CLIENT_SECRET ?? "",
  oidcScopes: process.env.OIDC_SCOPES ?? "openid profile email",
  oidcProviderName: process.env.OIDC_PROVIDER_NAME ?? "oidc",

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

  // Generic S3-compatible object storage.
  storageEndpoint: process.env.STORAGE_ENDPOINT ?? "",
  storageRegion: process.env.STORAGE_REGION ?? "auto",
  storageBucket: process.env.STORAGE_BUCKET ?? "",
  storageAccessKeyId: process.env.STORAGE_ACCESS_KEY_ID ?? "",
  storageSecretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY ?? "",
  storageForcePathStyle: process.env.STORAGE_FORCE_PATH_STYLE === "true",

  // Transitional compatibility only. These fields exist so imported helper
  // modules still compile while they are being replaced. They are empty unless
  // the owner explicitly opts in, so production does not silently depend on
  // Manus/Forge.
  allowLegacyForgeRuntime,
  forgeApiUrl: allowLegacyForgeRuntime ? (process.env.BUILT_IN_FORGE_API_URL ?? "") : "",
  forgeApiKey: allowLegacyForgeRuntime ? (process.env.BUILT_IN_FORGE_API_KEY ?? "") : "",
};
