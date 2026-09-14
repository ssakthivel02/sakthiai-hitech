import { int, mysqlEnum, mysqlTable, text, timestamp, varchar } from "drizzle-orm/mysql-core";

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
});

export const projects = mysqlTable("projects", {
  id: int("id").autoincrement().primaryKey(),
  workspaceId: int("workspaceId").notNull(),
  name: varchar("name", { length: 180 }).notNull(),
  description: text("description"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

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
});

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
});

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
});

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
  kind: mysqlEnum("kind", ["IMAGE", "IMAGE_EDIT", "VIDEO", "VIDEO_EXTENSION"]).notNull(),
  provider: varchar("provider", { length: 80 }).notNull(),
  model: varchar("model", { length: 160 }).notNull(),
  parametersJson: text("parametersJson").notNull(),
  sourceAssetIdsJson: text("sourceAssetIdsJson"),
  status: mysqlEnum("status", ["QUEUED", "SUBMITTED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED", "RETRYABLE"]).default("QUEUED").notNull(),
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
});

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
export type Citation = { filename: string; mimeType?: string; documentId: number; page?: number; section?: string; paragraph?: number; chunkId?: number; excerpt: string; sourceStart?: number; sourceEnd?: number; retrievalMethod?: "lexical" | "semantic" | "hybrid"; retrievalScore?: number };
