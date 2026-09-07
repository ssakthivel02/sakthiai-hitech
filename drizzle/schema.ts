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

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;
export type Workspace = typeof workspaces.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type Document = typeof documents.$inferSelect;
export type Citation = { filename: string; mimeType?: string; documentId: number; page?: number; section?: string; paragraph?: number; chunkId?: number; excerpt: string; sourceStart?: number; sourceEnd?: number; retrievalMethod?: "lexical" | "semantic" | "hybrid"; retrievalScore?: number };
