import { createHash } from "node:crypto";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { invokeLLM } from "./_core/llm";
import { protectedProcedure, publicProcedure, router } from "./_core/trpc";
import { getDb, ensureWorkspace, getWorkspaceForUser, listUserWorkspaces, listProjects, listDocuments, searchChunks, getConversationMessages, projects, documents, documentChunks, conversations, messages, type Citation } from "./db";
import { storagePut } from "./storage";
import { extractDocument } from "./provenance";
import { embeddingStatus, tryEmbed, serializeEmbedding } from "./embeddings";

const MAX_FILE_BYTES = 12 * 1024 * 1024;
const workspaceInput = z.object({ workspaceId: z.number().int().positive() });
const base64ToBuffer = (value: string) => Buffer.from(value.replace(/^data:[^;]+;base64,/, ""), "base64");
const safeFilename = (value: string) => value.normalize("NFKC").replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^\.+/, "").slice(0, 180) || "upload";

async function requireWorkspace(userId: number, workspaceId: number) { const workspace = await getWorkspaceForUser(userId, workspaceId); if (!workspace) throw new TRPCError({ code: "FORBIDDEN", message: "Workspace access denied" }); return workspace; }
function validateFile(buffer: Buffer, mimeType: string, filename: string) {
  const ext = filename.toLowerCase().split(".").pop();
  const allowed = ["pdf", "docx", "txt", "text", "plain"];
  if (!allowed.includes(ext || "")) throw new TRPCError({ code: "BAD_REQUEST", message: "Unsupported file extension" });
  if (ext === "pdf" && buffer.subarray(0, 5).toString() !== "%PDF-") throw new TRPCError({ code: "BAD_REQUEST", message: "File content is not a valid PDF" });
  if (ext === "docx" && buffer.subarray(0, 2).toString() !== "PK") throw new TRPCError({ code: "BAD_REQUEST", message: "File content is not a valid DOCX" });
  if (mimeType.length > 160) throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid MIME type" });
}

export const appRouter = router({
  system: systemRouter,
  auth: router({ me: publicProcedure.query(opts => opts.ctx.user), logout: publicProcedure.mutation(({ ctx }) => { const options = getSessionCookieOptions(ctx.req); ctx.res.clearCookie(COOKIE_NAME, { ...options, maxAge: -1 }); return { success: true } as const; }) }),
  runtime: router({ status: publicProcedure.query(() => ({ health: "alive" as const, readiness: process.env.DATABASE_URL ? "configured" as const : "degraded" as const, embeddings: embeddingStatus(), scanner: "SCANNER_NOT_CONFIGURED" as const })) }),
  workspace: router({ list: protectedProcedure.query(({ ctx }) => listUserWorkspaces(ctx.user.id)), ensure: protectedProcedure.mutation(({ ctx }) => ensureWorkspace(ctx.user)) }),
  projects: router({
    list: protectedProcedure.input(workspaceInput).query(({ ctx, input }) => requireWorkspace(ctx.user.id, input.workspaceId).then(() => listProjects(input.workspaceId))),
    create: protectedProcedure.input(workspaceInput.extend({ name: z.string().min(1).max(180), description: z.string().max(2000).optional() })).mutation(async ({ ctx, input }) => { await requireWorkspace(ctx.user.id, input.workspaceId); const db = await getDb(); if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" }); await db.insert(projects).values({ workspaceId: input.workspaceId, name: input.name, description: input.description ?? null }); return listProjects(input.workspaceId); }),
  }),
  files: router({
    list: protectedProcedure.input(workspaceInput).query(({ ctx, input }) => requireWorkspace(ctx.user.id, input.workspaceId).then(() => listDocuments(input.workspaceId))),
    upload: protectedProcedure.input(workspaceInput.extend({ projectId: z.number().int().positive().optional(), filename: z.string().min(1).max(255), mimeType: z.string().min(1), dataBase64: z.string().min(1) })).mutation(async ({ ctx, input }) => {
      await requireWorkspace(ctx.user.id, input.workspaceId);
      const buffer = base64ToBuffer(input.dataBase64);
      if (!buffer.length || buffer.byteLength > MAX_FILE_BYTES) throw new TRPCError({ code: "BAD_REQUEST", message: buffer.length ? "File exceeds 12MB limit" : "Empty file" });
      const filename = safeFilename(input.filename); validateFile(buffer, input.mimeType, filename);
      const contentHash = createHash("sha256").update(buffer).digest("hex");
      const db = await getDb(); if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      if (input.projectId) {
        const project = await db.select({ id: projects.id }).from(projects).where(and(eq(projects.id, input.projectId), eq(projects.workspaceId, input.workspaceId))).limit(1);
        if (!project[0]) throw new TRPCError({ code: "FORBIDDEN", message: "Project access denied" });
      }
      const duplicate = await db.select({ id: documents.id }).from(documents).where(and(eq(documents.workspaceId, input.workspaceId), eq(documents.contentHash, contentHash))).limit(1);
      if (duplicate[0]) throw new TRPCError({ code: "CONFLICT", message: "Duplicate document already exists" });
      const extracted = await extractDocument(buffer, input.mimeType);
      if (!extracted.text) throw new TRPCError({ code: "BAD_REQUEST", message: "No extractable text" });
      const stored = await storagePut(`${ctx.user.id}/${input.workspaceId}/${filename}`, buffer, input.mimeType);
      await db.insert(documents).values({ workspaceId: input.workspaceId, projectId: input.projectId ?? null, filename, mimeType: input.mimeType, storageKey: stored.key, extractedText: extracted.text, contentHash, pageCount: extracted.pageCount });
      const created = await db.select().from(documents).where(and(eq(documents.workspaceId, input.workspaceId), eq(documents.contentHash, contentHash))).limit(1); const document = created[0]; if (!document) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Document persistence failed" });
      const adapter = embeddingStatus();
      const chunks = [];
      for (let index = 0; index < extracted.segments.length; index += 1) { const segment = extracted.segments[index]; const embedded = await tryEmbed(segment.content); chunks.push({ ...segment, chunkIndex: index, documentId: document.id, workspaceId: input.workspaceId, embeddingJson: embedded ? serializeEmbedding(embedded.vector) : null, embeddingModel: embedded?.adapter.model ?? null }); }
      if (chunks.length) await db.insert(documentChunks).values(chunks);
      return { id: document.id, filename: document.filename, pageCount: document.pageCount, extractedCharacters: extracted.text.length, embedding: adapter, scanner: "SCANNER_NOT_CONFIGURED" as const };
    }),
  }),
  chat: router({
    history: protectedProcedure.input(workspaceInput.extend({ conversationId: z.number().int().positive() })).query(async ({ ctx, input }) => {
      await requireWorkspace(ctx.user.id, input.workspaceId);
      const db = await getDb(); if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const owned = await db.select({ id: conversations.id }).from(conversations).where(and(eq(conversations.id, input.conversationId), eq(conversations.workspaceId, input.workspaceId), eq(conversations.userId, ctx.user.id))).limit(1);
      if (!owned[0]) throw new TRPCError({ code: "FORBIDDEN", message: "Conversation access denied" });
      return getConversationMessages(input.workspaceId, input.conversationId);
    }),
    send: protectedProcedure.input(workspaceInput.extend({ conversationId: z.number().int().positive().optional(), message: z.string().trim().min(1).max(12000), language: z.enum(["en", "ta"]).default("en") })).mutation(async ({ ctx, input }) => {
      const started = Date.now(); await requireWorkspace(ctx.user.id, input.workspaceId); const db = await getDb(); if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      let conversationId = input.conversationId;
      if (conversationId) { const owned = await db.select({ id: conversations.id }).from(conversations).where(and(eq(conversations.id, conversationId), eq(conversations.workspaceId, input.workspaceId), eq(conversations.userId, ctx.user.id))).limit(1); if (!owned[0]) throw new TRPCError({ code: "FORBIDDEN", message: "Conversation access denied" }); }
      if (!conversationId) { await db.insert(conversations).values({ workspaceId: input.workspaceId, userId: ctx.user.id, title: input.message.slice(0, 80), language: input.language }); const row = await db.select({ id: conversations.id }).from(conversations).where(and(eq(conversations.workspaceId, input.workspaceId), eq(conversations.userId, ctx.user.id))).orderBy(desc(conversations.id)).limit(1); conversationId = row[0]?.id; }
      if (!conversationId) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Conversation creation failed" });
      const retrievalStarted = Date.now(); const matches = await searchChunks(input.workspaceId, input.message); const retrievalLatencyMs = Date.now() - retrievalStarted;
      const citations: Citation[] = matches.map(match => ({ filename: match.filename, mimeType: match.mimeType, documentId: match.documentId, page: match.page ?? undefined, section: match.section ?? undefined, paragraph: match.paragraph ?? undefined, chunkId: match.id, excerpt: match.content.slice(0, 260), sourceStart: match.sourceStart ?? undefined, sourceEnd: match.sourceEnd ?? undefined, retrievalMethod: match.retrievalMethod, retrievalScore: Number(match.score.toFixed(6)) }));
      await db.insert(messages).values({ conversationId, workspaceId: input.workspaceId, role: "user", content: input.message });
      if (!matches.length) { const answer = "INSUFFICIENT_EVIDENCE"; await db.insert(messages).values({ conversationId, workspaceId: input.workspaceId, role: "assistant", content: answer, citationsJson: "[]" }); return { conversationId, answer, citations: [], grounding: "INSUFFICIENT_EVIDENCE" as const, observability: { chatLatencyMs: Date.now() - started, retrievalLatencyMs, requestId: ctx.requestId } }; }
      const context = matches.map((m, i) => `[${i + 1}] ${m.filename}${m.page ? ` page ${m.page}` : m.section ? ` section ${m.section}` : ""}: ${m.content}`).join("\n\n");
      let answer = input.language === "ta" ? "ஆதாரங்களுடன் பதிலளிக்கிறேன்." : "I can help with that.";
      try { const response = await invokeLLM({ messages: [{ role: "system", content: `You are Sakthi AI Nexus. Answer in ${input.language === "ta" ? "Tamil" : "English"}. Use only the supplied evidence. If it does not support the answer, respond exactly INSUFFICIENT_EVIDENCE. Do not invent citations.\n\nEVIDENCE:\n${context}` }, { role: "user", content: input.message }] }); const content = response.choices?.[0]?.message?.content; if (typeof content === "string" && content.trim()) answer = content; } catch { answer = input.language === "ta" ? `ஆதாரங்களில் ${matches.length} பொருத்தமான பகுதி(கள்) கிடைத்தன.` : `I found ${matches.length} relevant source excerpt(s) in your workspace.`; }
      await db.insert(messages).values({ conversationId, workspaceId: input.workspaceId, role: "assistant", content: answer, citationsJson: JSON.stringify(citations) });
      return { conversationId, answer, citations, grounding: "GROUNDED_EVIDENCE" as const, observability: { chatLatencyMs: Date.now() - started, retrievalLatencyMs, requestId: ctx.requestId } };
    }),
  }),
});
export type AppRouter = typeof appRouter;
