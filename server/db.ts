import { and, asc, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { InsertUser, User, users, workspaces, workspaceMembers, projects, documents, documentChunks, conversations, messages } from "../drizzle/schema";
import { ENV } from "./_core/env";
import { createVerifiedMysqlPool } from "./_core/mysql";
import { cosineSimilarity, parseEmbedding, tryEmbed } from "./embeddings";

export type { Citation } from "../drizzle/schema";
export type RetrievalMethod = "lexical" | "semantic" | "hybrid";
export type SearchResult = typeof documentChunks.$inferSelect & { filename: string; mimeType: string; score: number; retrievalMethod: RetrievalMethod };
let _db: ReturnType<typeof drizzle> | null = null;
export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      const pool = await createVerifiedMysqlPool(
        process.env.DATABASE_URL,
        process.env.DATABASE_EXPECTED_NAME,
      );
      _db = drizzle(pool);
    } catch (error) {
      console.warn("[Database] Failed verified connection:", error);
      _db = null;
    }
  }
  return _db;
}
export async function upsertUser(user: InsertUser): Promise<void> { if (!user.openId) throw new Error("User openId is required for upsert"); const db = await getDb(); if (!db) return; const values: InsertUser = { openId: user.openId, name: user.name ?? null, email: user.email ?? null, loginMethod: user.loginMethod ?? null, lastSignedIn: new Date() }; const updateSet: Record<string, unknown> = { lastSignedIn: values.lastSignedIn, name: values.name, email: values.email, loginMethod: values.loginMethod }; if (user.role) { values.role = user.role; updateSet.role = user.role; } else if (user.openId === ENV.ownerOpenId) { values.role = "admin"; updateSet.role = "admin"; } await db.insert(users).values(values).onDuplicateKeyUpdate({ set: updateSet }); }
export async function getUserByOpenId(openId: string) { const db = await getDb(); if (!db) return undefined; const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1); return result[0]; }
export function assertWorkspaceAccess(userId: number, workspaceId: number, memberships: Array<{ userId: number; workspaceId: number }>) { return memberships.some(m => m.userId === userId && m.workspaceId === workspaceId); }
export async function ensureWorkspace(user: User) { const db = await getDb(); if (!db) throw new Error("Database unavailable"); const existing = await db.select({ workspace: workspaces }).from(workspaceMembers).innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id)).where(eq(workspaceMembers.userId, user.id)).limit(1); if (existing[0]?.workspace) return existing[0].workspace; const slug = `ws-${user.id}-${Date.now()}`; await db.insert(workspaces).values({ ownerUserId: user.id, name: `${user.name || "Personal"} workspace`, slug }); const created = await db.select().from(workspaces).where(eq(workspaces.slug, slug)).limit(1); if (!created[0]) throw new Error("Workspace creation failed"); await db.insert(workspaceMembers).values({ workspaceId: created[0].id, userId: user.id, role: "owner" }); return created[0]; }
export async function listUserWorkspaces(userId: number) { const db = await getDb(); if (!db) return []; return db.select({ workspace: workspaces }).from(workspaceMembers).innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id)).where(eq(workspaceMembers.userId, userId)); }
export async function getWorkspaceForUser(userId: number, workspaceId: number) { const db = await getDb(); if (!db) return undefined; const rows = await db.select({ workspace: workspaces }).from(workspaceMembers).innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id)).where(and(eq(workspaceMembers.userId, userId), eq(workspaces.id, workspaceId))).limit(1); return rows[0]?.workspace; }
export async function listProjects(workspaceId: number) { const db = await getDb(); return db ? db.select().from(projects).where(eq(projects.workspaceId, workspaceId)).orderBy(desc(projects.updatedAt)) : []; }
export async function listDocuments(workspaceId: number) { const db = await getDb(); return db ? db.select({ id: documents.id, filename: documents.filename, mimeType: documents.mimeType, pageCount: documents.pageCount, projectId: documents.projectId, createdAt: documents.createdAt }).from(documents).where(eq(documents.workspaceId, workspaceId)).orderBy(desc(documents.createdAt)) : []; }
export async function getConversationMessages(workspaceId: number, conversationId: number) { const db = await getDb(); return db ? db.select().from(messages).where(and(eq(messages.workspaceId, workspaceId), eq(messages.conversationId, conversationId))).orderBy(asc(messages.createdAt)) : []; }

/** Tenant filtering is deliberately performed in the database query before any scoring or fusion. */
export async function searchChunks(workspaceId: number, query: string): Promise<SearchResult[]> {
  const db = await getDb(); if (!db) return [];
  const rows = await db.select({ chunk: documentChunks, document: documents }).from(documentChunks).innerJoin(documents, eq(documentChunks.documentId, documents.id)).where(and(eq(documentChunks.workspaceId, workspaceId), eq(documents.workspaceId, workspaceId))).limit(500);
  const terms = query.toLowerCase().split(/\s+/).map(term => term.replace(/[^a-z0-9_-]/g, "")).filter(term => term.length > 2);
  const semantic = await tryEmbed(query);
  const scored = rows.map(({ chunk, document }) => {
    const lexicalHits = terms.reduce((count, term) => count + (chunk.content.toLowerCase().includes(term) ? 1 : 0), 0);
    const lexicalScore = terms.length ? lexicalHits / terms.length : 0;
    const vector = semantic ? parseEmbedding(chunk.embeddingJson) : null;
    const semanticScore = semantic && vector ? Math.max(0, cosineSimilarity(semantic.vector, vector)) : 0;
    const hasSemantic = Boolean(semantic && vector);
    const score = hasSemantic ? lexicalScore * 0.35 + semanticScore * 0.65 : lexicalScore;
    return { ...chunk, filename: document.filename, mimeType: document.mimeType, score, retrievalMethod: hasSemantic && lexicalHits > 0 ? "hybrid" as const : hasSemantic ? "semantic" as const : "lexical" as const };
  }).filter(row => row.score > 0).sort((a, b) => b.score - a.score).slice(0, 8);
  return scored;
}
export { conversations, documentChunks, documents, messages, projects, users, workspaceMembers, workspaces };
