import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import {
  InsertUser,
  User,
  users,
  workspaces,
  workspaceMembers,
  projects,
  documents,
  documentChunks,
  conversations,
  messages,
  creatorAssets,
} from "../drizzle/schema";
import { ENV } from "./_core/env";
import { createVerifiedMysqlPool } from "./_core/mysql";
import { tryEmbed } from "./embeddings";
import { searchWorkspaceChunks } from "./retrievalStore";
import type { RetrievalMethod } from "./retrieval";

export type { Citation } from "../drizzle/schema";
export type { RetrievalMethod } from "./retrieval";
export type SearchResult = typeof documentChunks.$inferSelect & {
  filename: string;
  mimeType: string;
  score: number;
  retrievalMethod: RetrievalMethod;
};

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

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) throw new Error("User openId is required for upsert");
  const db = await getDb();
  if (!db) return;

  const values: InsertUser = {
    openId: user.openId,
    name: user.name ?? null,
    email: user.email ?? null,
    loginMethod: user.loginMethod ?? null,
    lastSignedIn: new Date(),
  };
  const updateSet: Record<string, unknown> = {
    // lastSignedIn doubles as the persisted session generation (see advanceUserSessionGeneration): it must
    // NEVER move backwards, or a revoked token's generation could become current again.
    lastSignedIn: sql`GREATEST(${users.lastSignedIn}, ${values.lastSignedIn})`,
    name: values.name,
    email: values.email,
    loginMethod: values.loginMethod,
  };
  if (user.role) {
    values.role = user.role;
    updateSet.role = user.role;
  } else if (user.openId === ENV.ownerOpenId) {
    values.role = "admin";
    updateSet.role = "admin";
  }

  await db.insert(users).values(values).onDuplicateKeyUpdate({ set: updateSet });
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  return result[0];
}

/**
 * Atomically advances the persisted authentication generation without adding a
 * competing schema/migration. Existing `lastSignedIn` is the authoritative
 * server-side generation boundary: tokens from earlier generations are invalid.
 * GREATEST prevents a stale concurrent writer from moving the generation back.
 */
export async function advanceUserSessionGeneration(
  openId: string,
  now = new Date(),
): Promise<Date> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");

  const currentSecond = new Date(Math.floor(now.getTime() / 1_000) * 1_000);
  await db
    .update(users)
    .set({
      lastSignedIn: sql`GREATEST(DATE_ADD(${users.lastSignedIn}, INTERVAL 1 SECOND), ${currentSecond})`,
    })
    .where(eq(users.openId, openId));

  const updated = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  const user = updated[0];
  if (!user) throw new Error("User not found");
  return user.lastSignedIn;
}

export function assertWorkspaceAccess(
  userId: number,
  workspaceId: number,
  memberships: Array<{ userId: number; workspaceId: number }>,
) {
  return memberships.some(m => m.userId === userId && m.workspaceId === workspaceId);
}

export async function ensureWorkspace(user: User) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  // Serialise concurrent first-time callers for the SAME user by locking their users row, so parallel
  // requests (e.g. several tabs right after first login) can never create duplicate workspaces or collide on slug.
  return db.transaction(async tx => {
    await tx.select({ id: users.id }).from(users).where(eq(users.id, user.id)).for("update");
    const existing = await tx
      .select({ workspace: workspaces })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
      .where(eq(workspaceMembers.userId, user.id))
      .orderBy(asc(workspaces.id))
      .limit(1);
    if (existing[0]?.workspace) return existing[0].workspace;

    const slug = `ws-${user.id}-${Date.now()}-${randomUUID().slice(0, 8)}`;
    await tx.insert(workspaces).values({
      ownerUserId: user.id,
      name: `${user.name || "Personal"} workspace`,
      slug,
    });
    const created = await tx.select().from(workspaces).where(eq(workspaces.slug, slug)).limit(1);
    if (!created[0]) throw new Error("Workspace creation failed");
    await tx.insert(workspaceMembers).values({
      workspaceId: created[0].id,
      userId: user.id,
      role: "owner",
    });
    return created[0];
  });
}

export async function listUserWorkspaces(userId: number) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select({ workspace: workspaces })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
    .where(eq(workspaceMembers.userId, userId));
}

export async function getWorkspaceForUser(userId: number, workspaceId: number) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db
    .select({ workspace: workspaces })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
    .where(and(eq(workspaceMembers.userId, userId), eq(workspaces.id, workspaceId)))
    .limit(1);
  return rows[0]?.workspace;
}

/**
 * Returns the persisted rows that reference a storage key, with the workspace
 * that owns each. This is the authoritative source for object authorization.
 * Fails closed (throws) when the database is unavailable.
 */
export async function findStorageObjectOwners(
  key: string,
): Promise<Array<{ workspaceId: number; storageKey: string | null }>> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");

  const [documentRows, assetRows] = await Promise.all([
    db
      .select({ workspaceId: documents.workspaceId, storageKey: documents.storageKey })
      .from(documents)
      .where(eq(documents.storageKey, key))
      .limit(5),
    db
      .select({ workspaceId: creatorAssets.workspaceId, storageKey: creatorAssets.storageKey })
      .from(creatorAssets)
      .where(eq(creatorAssets.storageKey, key))
      .limit(5),
  ]);
  return [...documentRows, ...assetRows];
}

export async function listProjects(workspaceId: number) {
  const db = await getDb();
  return db
    ? db.select().from(projects).where(eq(projects.workspaceId, workspaceId)).orderBy(desc(projects.updatedAt))
    : [];
}

export async function listDocuments(workspaceId: number) {
  const db = await getDb();
  return db
    ? db
        .select({
          id: documents.id,
          filename: documents.filename,
          mimeType: documents.mimeType,
          pageCount: documents.pageCount,
          projectId: documents.projectId,
          createdAt: documents.createdAt,
        })
        .from(documents)
        .where(eq(documents.workspaceId, workspaceId))
        .orderBy(desc(documents.createdAt))
    : [];
}

export async function getConversationMessages(workspaceId: number, conversationId: number) {
  const db = await getDb();
  return db
    ? db
        .select()
        .from(messages)
        .where(and(eq(messages.workspaceId, workspaceId), eq(messages.conversationId, conversationId)))
        .orderBy(asc(messages.createdAt))
    : [];
}

/**
 * Tenant filtering happens in SQL (chunk and document workspace) before any scoring; see retrievalStore.ts
 * for the bounded lexical / legacy / semantic candidate strategy. The scorer is unchanged.
 */
export async function searchChunks(workspaceId: number, query: string): Promise<SearchResult[]> {
  const db = await getDb();
  if (!db) return [];
  const semantic = await tryEmbed(query);
  return searchWorkspaceChunks(db, workspaceId, query, semantic ? { vector: semantic.vector, model: semantic.adapter.model } : null);
}

export {
  conversations,
  documentChunks,
  documents,
  messages,
  projects,
  users,
  workspaceMembers,
  workspaces,
};
