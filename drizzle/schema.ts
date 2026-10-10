import { bigint, boolean, char, customType, date, datetime, decimal, index, int, mysqlEnum, mysqlTable, primaryKey, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core";

export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export const workspaces = mysqlTable("workspaces", {
  id: int("id").autoincrement().primaryKey(),
  ownerUserId: int("ownerUserId").notNull(),
  name: varchar("name", { length: 160 }).notNull(),
  slug: varchar("slug", { length: 180 }).notNull().unique(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const workspaceMembers = mysqlTable("workspaceMembers", {
  id: int("id").autoincrement().primaryKey(),
  workspaceId: int("workspaceId").notNull(),
  userId: int("userId").notNull(),
  role: mysqlEnum("role", ["owner", "member"]).default("member").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, table => [index("workspaceMembers_userId_workspaceId_idx").on(table.userId, table.workspaceId)]);

export const projects = mysqlTable("projects", {
  id: int("id").autoincrement().primaryKey(),
  workspaceId: int("workspaceId").notNull(),
  name: varchar("name", { length: 180 }).notNull(),
  description: text("description"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, table => [index("projects_workspaceId_idx").on(table.workspaceId)]);

export const documents = mysqlTable("documents", {
  id: int("id").autoincrement().primaryKey(),
  workspaceId: int("workspaceId").notNull(),
  projectId: int("projectId"),
  filename: varchar("filename", { length: 255 }).notNull(),
  mimeType: varchar("mimeType", { length: 160 }).notNull(),
  storageKey: text("storageKey"),
  extractedText: text("extractedText").notNull(),
  contentHash: varchar("contentHash", { length: 64 }).notNull(),
  pageCount: int("pageCount").default(1).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, table => [
  index("documents_workspaceId_createdAt_idx").on(table.workspaceId, table.createdAt),
  // (workspaceId, contentHash) is already indexed by documents_workspace_hash_idx (migration 0002).
  // documents_storageKey_idx is a PREFIX index (storageKey(191)); Drizzle cannot express prefix lengths, so it exists only in migration 0006.
]);

export const documentChunks = mysqlTable("documentChunks", {
  id: int("id").autoincrement().primaryKey(),
  documentId: int("documentId").notNull(),
  workspaceId: int("workspaceId").notNull(),
  chunkIndex: int("chunkIndex").notNull(),
  page: int("page"),
  section: varchar("section", { length: 500 }),
  paragraph: int("paragraph"),
  sourceStart: int("sourceStart"),
  sourceEnd: int("sourceEnd"),
  content: text("content").notNull(),
  embeddingJson: text("embeddingJson"),
  embeddingModel: varchar("embeddingModel", { length: 160 }),
  /** normalizeRetrievalText(content), maintained at ingestion; NULL for legacy rows until backfilled. Enables DB-side lexical prefiltering. */
  searchText: text("searchText"),
}, table => [
  // (workspaceId, documentId) is already indexed by chunks_workspace_document_idx (migration 0002).
  index("documentChunks_documentId_chunkIndex_idx").on(table.documentId, table.chunkIndex),
]);

export const conversations = mysqlTable("conversations", {
  id: int("id").autoincrement().primaryKey(),
  workspaceId: int("workspaceId").notNull(),
  userId: int("userId").notNull(),
  title: varchar("title", { length: 180 }).notNull(),
  language: mysqlEnum("language", ["en", "ta"]).default("en").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export const messages = mysqlTable("messages", {
  id: int("id").autoincrement().primaryKey(),
  conversationId: int("conversationId").notNull(),
  workspaceId: int("workspaceId").notNull(),
  role: mysqlEnum("role", ["user", "assistant", "system"]).notNull(),
  content: text("content").notNull(),
  citationsJson: text("citationsJson"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, table => [index("messages_workspaceId_conversationId_createdAt_idx").on(table.workspaceId, table.conversationId, table.createdAt)]);

/** SakthiAI Creator owns orchestration state; media providers remain replaceable workers. */
export const creatorProjects = mysqlTable("creatorProjects", {
  id: int("id").autoincrement().primaryKey(),
  workspaceId: int("workspaceId").notNull(),
  projectId: int("projectId"),
  name: varchar("name", { length: 180 }).notNull(),
  status: mysqlEnum("status", ["DRAFT", "ACTIVE", "APPROVAL_LOCKED", "ARCHIVED"]).default("DRAFT").notNull(),
  canonicalLyrics: text("canonicalLyrics"),
  lyricsApprovedAt: timestamp("lyricsApprovedAt"),
  audioMasterAssetId: int("audioMasterAssetId"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export const creatorScenes = mysqlTable("creatorScenes", {
  id: int("id").autoincrement().primaryKey(),
  workspaceId: int("workspaceId").notNull(),
  creatorProjectId: int("creatorProjectId").notNull(),
  sceneIndex: int("sceneIndex").notNull(),
  title: varchar("title", { length: 180 }).notNull(),
  startMs: int("startMs"),
  endMs: int("endMs"),
  notes: text("notes"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export const creatorShots = mysqlTable("creatorShots", {
  id: int("id").autoincrement().primaryKey(),
  workspaceId: int("workspaceId").notNull(),
  creatorProjectId: int("creatorProjectId").notNull(),
  sceneId: int("sceneId").notNull(),
  shotIndex: int("shotIndex").notNull(),
  title: varchar("title", { length: 180 }).notNull(),
  prompt: text("prompt"),
  startMs: int("startMs"),
  endMs: int("endMs"),
  status: mysqlEnum("status", ["PLANNED", "GENERATING", "READY", "REVIEW", "APPROVED", "REJECTED"]).default("PLANNED").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export const creatorAssets = mysqlTable("creatorAssets", {
  id: int("id").autoincrement().primaryKey(),
  workspaceId: int("workspaceId").notNull(),
  creatorProjectId: int("creatorProjectId").notNull(),
  sceneId: int("sceneId"),
  shotId: int("shotId"),
  assetType: mysqlEnum("assetType", ["REFERENCE", "IMAGE", "VIDEO", "AUDIO_MASTER", "AUDIO", "SUBTITLE", "RENDER", "OTHER"]).notNull(),
  mimeType: varchar("mimeType", { length: 160 }).notNull(),
  storageKey: text("storageKey").notNull(),
  checksumSha256: varchar("checksumSha256", { length: 64 }).notNull(),
  byteSize: int("byteSize"),
  immutable: int("immutable").default(0).notNull(),
  provenanceJson: text("provenanceJson").notNull(),
  reviewDecision: mysqlEnum("reviewDecision", ["PENDING", "APPROVED", "REJECTED"]).default("PENDING").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const creatorReferences = mysqlTable("creatorReferences", {
  id: int("id").autoincrement().primaryKey(),
  workspaceId: int("workspaceId").notNull(),
  creatorProjectId: int("creatorProjectId").notNull(),
  assetId: int("assetId").notNull(),
  kind: mysqlEnum("kind", ["CHARACTER", "STYLE", "LOCATION", "OBJECT"]).notNull(),
  label: varchar("label", { length: 180 }).notNull(),
  immutable: int("immutable").default(1).notNull(),
  approvedAt: timestamp("approvedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const creatorGenerations = mysqlTable("creatorGenerations", {
  id: int("id").autoincrement().primaryKey(),
  workspaceId: int("workspaceId").notNull(),
  creatorProjectId: int("creatorProjectId").notNull(),
  sceneId: int("sceneId"),
  shotId: int("shotId"),
  idempotencyKey: varchar("idempotencyKey", { length: 64 }),
  kind: mysqlEnum("kind", ["IMAGE", "IMAGE_EDIT", "VIDEO", "VIDEO_EXTENSION"]).notNull(),
  provider: varchar("provider", { length: 80 }).notNull(),
  model: varchar("model", { length: 160 }).notNull(),
  parametersJson: text("parametersJson").notNull(),
  sourceAssetIdsJson: text("sourceAssetIdsJson"),
  status: mysqlEnum("status", ["QUEUED", "SUBMISSION_UNKNOWN", "SUBMITTED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED", "RETRYABLE"]).default("QUEUED").notNull(),
  outputAssetId: int("outputAssetId"),
  attempt: int("attempt").default(1).notNull(),
  failureClass: varchar("failureClass", { length: 80 }),
  errorMessage: text("errorMessage"),
  costMicros: int("costMicros"),
  currency: varchar("currency", { length: 3 }),
  latencyMs: int("latencyMs"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  completedAt: timestamp("completedAt"),
}, table => [
  uniqueIndex("creatorGenerations_workspaceId_idempotencyKey_unique").on(table.workspaceId, table.idempotencyKey),
]);

export const creatorProviderJobs = mysqlTable("creatorProviderJobs", {
  id: int("id").autoincrement().primaryKey(),
  workspaceId: int("workspaceId").notNull(),
  creatorProjectId: int("creatorProjectId").notNull(),
  generationId: int("generationId").notNull(),
  provider: varchar("provider", { length: 80 }).notNull(),
  providerJobId: varchar("providerJobId", { length: 512 }).notNull(),
  status: mysqlEnum("status", ["SUBMITTED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED", "RETRYABLE"]).default("SUBMITTED").notNull(),
  snapshotJson: text("snapshotJson"),
  failureClass: varchar("failureClass", { length: 80 }),
  costMicros: int("costMicros"),
  currency: varchar("currency", { length: 3 }),
  latencyMs: int("latencyMs"),
  submittedAt: timestamp("submittedAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  completedAt: timestamp("completedAt"),
});

export const creatorTimelines = mysqlTable("creatorTimelines", {
  id: int("id").autoincrement().primaryKey(),
  workspaceId: int("workspaceId").notNull(),
  creatorProjectId: int("creatorProjectId").notNull(),
  name: varchar("name", { length: 180 }).notNull(),
  audioMasterAssetId: int("audioMasterAssetId"),
  width: int("width").default(1920).notNull(),
  height: int("height").default(1080).notNull(),
  fps: int("fps").default(24).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export const creatorTimelineItems = mysqlTable("creatorTimelineItems", {
  id: int("id").autoincrement().primaryKey(),
  workspaceId: int("workspaceId").notNull(),
  creatorProjectId: int("creatorProjectId").notNull(),
  timelineId: int("timelineId").notNull(),
  shotId: int("shotId"),
  assetId: int("assetId").notNull(),
  track: int("track").default(1).notNull(),
  sortOrder: int("sortOrder").default(0).notNull(),
  startMs: int("startMs").notNull(),
  endMs: int("endMs").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const creatorCaptionCues = mysqlTable("creatorCaptionCues", {
  id: int("id").autoincrement().primaryKey(),
  workspaceId: int("workspaceId").notNull(),
  creatorProjectId: int("creatorProjectId").notNull(),
  timelineId: int("timelineId").notNull(),
  language: mysqlEnum("language", ["ta", "en"]).default("ta").notNull(),
  startMs: int("startMs").notNull(),
  endMs: int("endMs").notNull(),
  text: text("text").notNull(),
  locked: int("locked").default(1).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export const creatorReviews = mysqlTable("creatorReviews", {
  id: int("id").autoincrement().primaryKey(),
  workspaceId: int("workspaceId").notNull(),
  creatorProjectId: int("creatorProjectId").notNull(),
  generationId: int("generationId"),
  shotId: int("shotId"),
  assetId: int("assetId"),
  reviewType: mysqlEnum("reviewType", ["QUALITY", "HUMAN_TAMIL", "HUMAN_VISUAL"]).notNull(),
  decision: mysqlEnum("decision", ["PENDING", "PASS", "ASSISTED_HUMAN_REVIEW", "REGENERATE", "REJECT"]).default("PENDING").notNull(),
  reviewerUserId: int("reviewerUserId"),
  scoresJson: text("scoresJson"),
  notes: text("notes"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const creatorExports = mysqlTable("creatorExports", {
  id: int("id").autoincrement().primaryKey(),
  workspaceId: int("workspaceId").notNull(),
  creatorProjectId: int("creatorProjectId").notNull(),
  timelineId: int("timelineId").notNull(),
  assetId: int("assetId"),
  status: mysqlEnum("status", ["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED"]).default("QUEUED").notNull(),
  width: int("width").default(1920).notNull(),
  height: int("height").default(1080).notNull(),
  format: varchar("format", { length: 32 }).default("mp4").notNull(),
  renderer: varchar("renderer", { length: 80 }).default("ffmpeg").notNull(),
  parametersJson: text("parametersJson"),
  checksumSha256: varchar("checksumSha256", { length: 64 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  completedAt: timestamp("completedAt"),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;
export type Workspace = typeof workspaces.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type Document = typeof documents.$inferSelect;
export type CreatorProject = typeof creatorProjects.$inferSelect;
export type CreatorAsset = typeof creatorAssets.$inferSelect;
export type CreatorGeneration = typeof creatorGenerations.$inferSelect;
export type CreatorProviderJob = typeof creatorProviderJobs.$inferSelect;
export type CreatorTimeline = typeof creatorTimelines.$inferSelect;
export type Citation = { filename: string; mimeType?: string; documentId: number; page?: number; section?: string; paragraph?: number; chunkId?: number; excerpt: string; sourceStart?: number; sourceEnd?: number; retrievalMethod?: "lexical" | "semantic" | "hybrid"; retrievalScore?: number; /** Present only for governed read-only MCP tool evidence (documentId is 0 for these). */ source?: "mcp"; mcp?: McpEvidenceProvenance };
export type McpEvidenceProvenance = { connectorId: string; connectorName: string; serverName: string | null; serverVersion: string | null; endpointOrigin: string; tool: string; retrievedAt: string; responseBytes: number; truncated: boolean };

// ---- Provider policy and runtime enforcement (shared across server instances) ----

/** Per-workspace opt-in for external / metered model providers. A missing row means DENIED (fail closed). */
export const providerWorkspacePolicies = mysqlTable("providerWorkspacePolicies", {
  workspaceId: int("workspaceId").primaryKey(),
  externalEnabled: boolean("externalEnabled").default(false).notNull(),
  meteredEnabled: boolean("meteredEnabled").default(false).notNull(),
  maxRequestsPerDay: bigint("maxRequestsPerDay", { mode: "number" }),
  maxTokensPerDay: bigint("maxTokensPerDay", { mode: "number" }),
  maxCostPerDay: decimal("maxCostPerDay", { precision: 18, scale: 6 }),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

/** UTC-day usage counters. Mutated only through single conditional UPDATE statements. */
export const providerUsageWindows = mysqlTable("providerUsageWindows", {
  workspaceId: int("workspaceId").notNull(),
  windowStart: date("windowStart", { mode: "string" }).notNull(),
  requests: bigint("requests", { mode: "number" }).default(0).notNull(),
  tokens: bigint("tokens", { mode: "number" }).default(0).notNull(),
  cost: decimal("cost", { precision: 18, scale: 6 }).default("0").notNull(),
  estimatedCommits: bigint("estimatedCommits", { mode: "number" }).default(0).notNull(),
}, table => [primaryKey({ columns: [table.workspaceId, table.windowStart] })]);

/** One row per reservation so commit/release are idempotent across instances. */
export const providerUsageHolds = mysqlTable("providerUsageHolds", {
  id: varchar("id", { length: 64 }).primaryKey(),
  workspaceId: int("workspaceId").notNull(),
  providerId: varchar("providerId", { length: 96 }).notNull(),
  windowStart: date("windowStart", { mode: "string" }).notNull(),
  tokens: bigint("tokens", { mode: "number" }).notNull(),
  cost: decimal("cost", { precision: 18, scale: 6 }).default("0").notNull(),
  state: mysqlEnum("state", ["HELD", "COMMITTED", "RELEASED"]).default("HELD").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, table => [index("providerUsageHolds_state_createdAt_idx").on(table.state, table.createdAt)]);

/** Distributed circuit-breaker state; transitions use compare-and-set on the previous values. */
export const providerBreakerStates = mysqlTable("providerBreakerStates", {
  providerId: varchar("providerId", { length: 96 }).primaryKey(),
  state: mysqlEnum("state", ["CLOSED", "OPEN", "HALF_OPEN"]).default("CLOSED").notNull(),
  consecutiveFailures: int("consecutiveFailures").default(0).notNull(),
  openedAt: bigint("openedAt", { mode: "number" }).default(0).notNull(),
  probeInFlightSince: bigint("probeInFlightSince", { mode: "number" }),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

/**
 * Server-issued OAuth login transactions shared by every application instance. Only SHA-256 digests are stored
 * (never the usable nonce or PKCE challenge). Consumption is one conditional UPDATE, so exactly one callback wins.
 */
export const oauthLoginTransactions = mysqlTable("oauthLoginTransactions", {
  nonceHash: char("nonceHash", { length: 64 }).primaryKey(),
  challengeHash: char("challengeHash", { length: 64 }).notNull(),
  createdAt: datetime("createdAt", { fsp: 3 }).notNull(),
  expiresAt: datetime("expiresAt", { fsp: 3 }).notNull(),
  consumedAt: datetime("consumedAt", { fsp: 3 }),
}, table => ({ expiresIdx: index("oauthLoginTransactions_expiresAt_idx").on(table.expiresAt) }));

/** Durable, workspace-owned task state. Leases + attempt-number fencing make execution crash-safe and resumable. */
export const durableTasks = mysqlTable("durableTasks", {
  id: char("id", { length: 36 }).primaryKey(),
  workspaceId: int("workspaceId").notNull(),
  createdByUserId: int("createdByUserId"),
  type: varchar("type", { length: 96 }).notNull(),
  state: mysqlEnum("state", ["QUEUED", "RUNNING", "WAITING", "SUCCEEDED", "FAILED", "CANCELLED"]).default("QUEUED").notNull(),
  idempotencyKey: varchar("idempotencyKey", { length: 128 }),
  inputHash: char("inputHash", { length: 64 }).notNull(),
  inputJson: text("inputJson").notNull(),
  checkpointJson: text("checkpointJson"),
  checkpointSeq: int("checkpointSeq").default(0).notNull(),
  progressPercent: int("progressPercent"),
  progressNote: varchar("progressNote", { length: 255 }),
  resultJson: text("resultJson"),
  attempt: int("attempt").default(0).notNull(),
  maxAttempts: int("maxAttempts").default(3).notNull(),
  retryAfter: datetime("retryAfter", { fsp: 3 }),
  leaseOwner: varchar("leaseOwner", { length: 96 }),
  leaseExpiresAt: datetime("leaseExpiresAt", { fsp: 3 }),
  cancelRequested: boolean("cancelRequested").default(false).notNull(),
  failureClass: mysqlEnum("failureClass", ["RETRYABLE", "NON_RETRYABLE", "PROVIDER_UNAVAILABLE", "BUDGET_DENIED", "POLICY_DENIED", "LEASE_EXPIRED", "INTERNAL"]),
  errorMessage: varchar("errorMessage", { length: 500 }),
  createdAt: datetime("createdAt", { fsp: 3 }).notNull(),
  updatedAt: datetime("updatedAt", { fsp: 3 }).notNull(),
  startedAt: datetime("startedAt", { fsp: 3 }),
  finishedAt: datetime("finishedAt", { fsp: 3 }),
}, table => ({
  idempotencyUq: uniqueIndex("durableTasks_workspace_idempotency_uq").on(table.workspaceId, table.idempotencyKey),
  stateRetryIdx: index("durableTasks_state_retry_idx").on(table.state, table.retryAfter, table.createdAt),
  workspaceCreatedIdx: index("durableTasks_workspace_created_idx").on(table.workspaceId, table.createdAt),
}));

/** Completed side-effect markers: a resumed/retried task replays recorded results instead of repeating the effect. */
export const durableTaskEffects = mysqlTable("durableTaskEffects", {
  taskId: char("taskId", { length: 36 }).notNull(),
  effectKey: varchar("effectKey", { length: 128 }).notNull(),
  resultJson: text("resultJson"),
  createdAt: datetime("createdAt", { fsp: 3 }).notNull(),
}, table => ({ pk: primaryKey({ columns: [table.taskId, table.effectKey] }) }));

/** Workspace-owned READ-ONLY MCP connector registrations. Secrets are never stored: `secretRef` names a server-side secret. */
export const mcpConnectors = mysqlTable("mcpConnectors", {
  id: char("id", { length: 36 }).primaryKey(),
  workspaceId: int("workspaceId").notNull(),
  name: varchar("name", { length: 96 }).notNull(),
  endpoint: varchar("endpoint", { length: 500 }).notNull(),
  enabled: boolean("enabled").default(false).notNull(),
  secretRef: varchar("secretRef", { length: 64 }),
  allowedToolsJson: text("allowedToolsJson"),
  timeoutMs: int("timeoutMs").default(8000).notNull(),
  maxResponseBytes: int("maxResponseBytes").default(262144).notNull(),
  createdByUserId: int("createdByUserId"),
  createdAt: datetime("createdAt", { fsp: 3 }).notNull(),
  updatedAt: datetime("updatedAt", { fsp: 3 }).notNull(),
}, table => ({ nameUq: uniqueIndex("mcpConnectors_workspace_name_uq").on(table.workspaceId, table.name) }));

export const mcpConnectorAudit = mysqlTable("mcpConnectorAudit", {
  id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
  workspaceId: int("workspaceId").notNull(),
  connectorId: char("connectorId", { length: 36 }).notNull(),
  actorUserId: int("actorUserId"),
  action: mysqlEnum("action", ["REGISTER", "ENABLE", "DISABLE", "REMOVE", "DISCOVER", "READ_RESOURCE", "CALL_TOOL"]).notNull(),
  target: varchar("target", { length: 255 }),
  outcome: mysqlEnum("outcome", ["OK", "DENIED", "ERROR", "TIMEOUT", "TOO_LARGE", "INVALID"]).notNull(),
  detail: varchar("detail", { length: 255 }),
  responseBytes: int("responseBytes"),
  createdAt: datetime("createdAt", { fsp: 3 }).notNull(),
}, table => ({ workspaceCreatedIdx: index("mcpConnectorAudit_workspace_created_idx").on(table.workspaceId, table.createdAt) }));

const mediumBlob = customType<{ data: Buffer }>({ dataType: () => "mediumblob" });

/** Resumable upload sessions. Raw bytes live ONLY in fileUploadChunks (quarantine) until scan+extraction pass; never in object storage. */
export const fileUploadSessions = mysqlTable("fileUploadSessions", {
  id: char("id", { length: 36 }).primaryKey(),
  workspaceId: int("workspaceId").notNull(),
  userId: int("userId").notNull(),
  projectId: int("projectId"),
  filename: varchar("filename", { length: 255 }).notNull(),
  mimeType: varchar("mimeType", { length: 160 }).notNull(),
  declaredBytes: int("declaredBytes").notNull(),
  declaredSha256: char("declaredSha256", { length: 64 }).notNull(),
  chunkSize: int("chunkSize").notNull(),
  totalChunks: int("totalChunks").notNull(),
  state: mysqlEnum("state", ["OPEN", "FINALIZING", "COMPLETED", "REJECTED", "EXPIRED", "ABORTED"]).default("OPEN").notNull(),
  rejectReason: varchar("rejectReason", { length: 64 }),
  lastError: varchar("lastError", { length: 160 }),
  scanStatus: varchar("scanStatus", { length: 16 }),
  scanEngine: varchar("scanEngine", { length: 32 }),
  documentId: int("documentId"),
  createdAt: datetime("createdAt", { fsp: 3 }).notNull(),
  updatedAt: datetime("updatedAt", { fsp: 3 }).notNull(),
  expiresAt: datetime("expiresAt", { fsp: 3 }).notNull(),
}, table => ({
  workspaceStateIdx: index("fileUploadSessions_workspace_state_idx").on(table.workspaceId, table.state),
  stateExpiresIdx: index("fileUploadSessions_state_expires_idx").on(table.state, table.expiresAt),
}));

export const fileUploadChunks = mysqlTable("fileUploadChunks", {
  uploadId: char("uploadId", { length: 36 }).notNull(),
  chunkIndex: int("chunkIndex").notNull(),
  bytes: int("bytes").notNull(),
  sha256: char("sha256", { length: 64 }).notNull(),
  data: mediumBlob("data").notNull(),
}, table => ({ pk: primaryKey({ columns: [table.uploadId, table.chunkIndex] }) }));
