import { TASK_STATES, toView, CHAT_ANSWER_TASK, TaskIdempotencyConflict } from "./tasks";
import { getSharedTaskStore, asyncAnswersEnabled } from "./tasks/shared";
import { toCitations, groundedSystemPrompt } from "./chat/grounded";
import { ResumableIngestion, UploadStore, IngestError, createCommitter, projectBelongsToWorkspace } from "./ingestion";
import { McpConnectorService, McpConnectorStore, McpPolicyError } from "./connectors/mcp";
import { createHash } from "node:crypto";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { sdk } from "./_core/sdk";
import { systemRouter } from "./_core/systemRouter";
import { getProviderGateway, type GatewayOutcome } from "./gateway";
import { protectedProcedure, publicProcedure, router } from "./_core/trpc";
import { getDb, ensureWorkspace, getWorkspaceForUser, getWorkspaceRole, listUserWorkspaces, listProjects, listDocuments, searchChunks, getConversationMessages, projects, documents, documentChunks, conversations, messages, type Citation } from "./db";
import { storagePut } from "./storage";
import { extractDocument } from "./provenance";
import { embeddingStatus, tryEmbed, serializeEmbedding } from "./embeddings";
import { searchTextFor } from "./retrievalStore";
import { creatorRouter } from "./creator/router";
import { malwareScannerConfigurationStatus } from "./security/malwareScanner";
import { resolveGroundedOutcome, type ModelResult } from "./grounding";

const MAX_FILE_BYTES = 12 * 1024 * 1024;
const sharedTaskStore = () => getSharedTaskStore();
let mcpService: McpConnectorService | null = null;
const sharedMcp = () => (mcpService ??= new McpConnectorService({ store: new McpConnectorStore(getDb) }));
let ingestion: ResumableIngestion | null = null;
const sharedIngestion = () => (ingestion ??= new ResumableIngestion({ store: new UploadStore(getDb), commit: createCommitter(), projectAllowed: projectBelongsToWorkspace }));
const ingestErrorCode = { DISABLED: "FORBIDDEN", INVALID: "BAD_REQUEST", NOT_FOUND: "NOT_FOUND", CONFLICT: "CONFLICT", LIMIT: "TOO_MANY_REQUESTS", CLOSED: "CONFLICT", INCOMPLETE: "PRECONDITION_FAILED", INFECTED: "BAD_REQUEST", SCANNER_UNAVAILABLE: "SERVICE_UNAVAILABLE", DUPLICATE: "CONFLICT", EXTRACTION_FAILED: "BAD_REQUEST", PROJECT_DENIED: "FORBIDDEN" } as const;
async function ingestGuard<T>(run: () => Promise<T>): Promise<T> { try { return await run(); } catch (error) { if (error instanceof IngestError) throw new TRPCError({ code: ingestErrorCode[error.code], message: error.message }); throw error; } }
const mcpErrorCode = { DENIED: "FORBIDDEN", NOT_FOUND: "NOT_FOUND", INVALID: "BAD_REQUEST", DUPLICATE: "CONFLICT", UNAVAILABLE: "BAD_GATEWAY", TIMEOUT: "TIMEOUT", TOO_LARGE: "PAYLOAD_TOO_LARGE" } as const;
async function mcpGuard<T>(run: () => Promise<T>): Promise<T> { try { return await run(); } catch (error) { if (error instanceof McpPolicyError) throw new TRPCError({ code: mcpErrorCode[error.code], message: error.message }); throw error; } }
async function requireWorkspaceOwner(userId: number, workspaceId: number) { const role = await getWorkspaceRole(userId, workspaceId); if (role !== "owner") throw new TRPCError({ code: "FORBIDDEN", message: "Workspace owner role required" }); }
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
  creator: creatorRouter,
  auth: router({ me: publicProcedure.query(opts => opts.ctx.user), logout: protectedProcedure.mutation(async ({ ctx }) => { await sdk.revokeAllSessions(ctx.user.openId); const options = getSessionCookieOptions(ctx.req); ctx.res.clearCookie(COOKIE_NAME, { ...options, maxAge: -1 }); return { success: true } as const; }) }),
  runtime: router({ status: publicProcedure.query(() => ({ health: "alive" as const, readiness: process.env.DATABASE_URL ? "configured" as const : "degraded" as const, embeddings: embeddingStatus(), scanner: { configuration: malwareScannerConfigurationStatus(), liveProbe: "not_checked" as const, requiredForCurrentReadiness: false as const, fileIngestion: "coming_soon" as const } })) }),
  workspace: router({ list: protectedProcedure.query(({ ctx }) => listUserWorkspaces(ctx.user.id)), ensure: protectedProcedure.mutation(({ ctx }) => ensureWorkspace(ctx.user)) }),
  projects: router({
    list: protectedProcedure.input(workspaceInput).query(({ ctx, input }) => requireWorkspace(ctx.user.id, input.workspaceId).then(() => listProjects(input.workspaceId))),
    create: protectedProcedure.input(workspaceInput.extend({ name: z.string().min(1).max(180), description: z.string().max(2000).optional() })).mutation(async ({ ctx, input }) => { await requireWorkspace(ctx.user.id, input.workspaceId); const db = await getDb(); if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" }); await db.insert(projects).values({ workspaceId: input.workspaceId, name: input.name, description: input.description ?? null }); return listProjects(input.workspaceId); }),
  }),
  files: router({
    /** Resumable, quarantined ingestion (backend only; off unless FILE_INGESTION_BACKEND_ENABLED=true; the upload UI stays gated). */
    resumable: router({
      begin: protectedProcedure.input(workspaceInput.extend({ projectId: z.number().int().positive().optional(), filename: z.string().min(1).max(255), mimeType: z.string().min(1).max(160), sizeBytes: z.number().int().positive(), sha256: z.string().length(64), chunkSize: z.number().int().positive() })).mutation(async ({ ctx, input }) => { await requireWorkspace(ctx.user.id, input.workspaceId); const { workspaceId, ...rest } = input; return ingestGuard(() => sharedIngestion().begin({ workspaceId, userId: ctx.user.id }, rest)); }),
      putChunk: protectedProcedure.input(workspaceInput.extend({ uploadId: z.string().length(36), index: z.number().int().min(0), dataBase64: z.string().min(1).max(200_000), sha256: z.string().length(64).optional() })).mutation(async ({ ctx, input }) => { await requireWorkspace(ctx.user.id, input.workspaceId); return ingestGuard(() => sharedIngestion().putChunk({ workspaceId: input.workspaceId, userId: ctx.user.id }, input.uploadId, input.index, base64ToBuffer(input.dataBase64), input.sha256)); }),
      status: protectedProcedure.input(workspaceInput.extend({ uploadId: z.string().length(36) })).query(async ({ ctx, input }) => { await requireWorkspace(ctx.user.id, input.workspaceId); return ingestGuard(() => sharedIngestion().status({ workspaceId: input.workspaceId, userId: ctx.user.id }, input.uploadId)); }),
      finalize: protectedProcedure.input(workspaceInput.extend({ uploadId: z.string().length(36) })).mutation(async ({ ctx, input }) => { await requireWorkspace(ctx.user.id, input.workspaceId); return ingestGuard(() => sharedIngestion().finalize({ workspaceId: input.workspaceId, userId: ctx.user.id }, input.uploadId)); }),
      abort: protectedProcedure.input(workspaceInput.extend({ uploadId: z.string().length(36) })).mutation(async ({ ctx, input }) => { await requireWorkspace(ctx.user.id, input.workspaceId); return ingestGuard(() => sharedIngestion().abort({ workspaceId: input.workspaceId, userId: ctx.user.id }, input.uploadId)); }),
    }),
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
      for (let index = 0; index < extracted.segments.length; index += 1) { const segment = extracted.segments[index]; const embedded = await tryEmbed(segment.content); chunks.push({ ...segment, searchText: searchTextFor(segment.content), chunkIndex: index, documentId: document.id, workspaceId: input.workspaceId, embeddingJson: embedded ? serializeEmbedding(embedded.vector) : null, embeddingModel: embedded?.adapter.model ?? null }); }
      if (chunks.length) await db.insert(documentChunks).values(chunks);
      return { id: document.id, filename: document.filename, pageCount: document.pageCount, extractedCharacters: extracted.text.length, embedding: adapter, scanner: "clean" as const };
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
      const citations: Citation[] = toCitations(matches);
      await db.insert(messages).values({ conversationId, workspaceId: input.workspaceId, role: "user", content: input.message });
      if (!matches.length) { const answer = "INSUFFICIENT_EVIDENCE"; await db.insert(messages).values({ conversationId, workspaceId: input.workspaceId, role: "assistant", content: answer, citationsJson: "[]" }); return { conversationId, answer, citations: [], grounding: "INSUFFICIENT_EVIDENCE" as const, observability: { chatLatencyMs: Date.now() - started, retrievalLatencyMs, requestId: ctx.requestId } }; }
      let model: ModelResult = { status: "failed" };
      let gatewayOutcome: GatewayOutcome;
      try { gatewayOutcome = await getProviderGateway().invoke({ requestId: ctx.requestId, workspaceId: input.workspaceId, messages: [{ role: "system", content: groundedSystemPrompt(input.language, matches) }, { role: "user", content: input.message }], intents: ["conversation"], requiredCapabilities: ["chat"], optionalCapabilities: input.language === "ta" ? ["multilingual"] : [] }); } catch { gatewayOutcome = { status: "failed", reason: "internal_error", attempts: [], latencyMs: 0 }; }
      if (gatewayOutcome.status === "returned") model = { status: "returned", content: gatewayOutcome.content };
      const outcome = resolveGroundedOutcome({ language: input.language, evidenceCount: matches.length, model });
      const answerCitations = outcome.includeCitations ? citations : [];
      await db.insert(messages).values({ conversationId, workspaceId: input.workspaceId, role: "assistant", content: outcome.answer, citationsJson: JSON.stringify(answerCitations) });
      return { conversationId, answer: outcome.answer, citations: answerCitations, grounding: outcome.grounding, observability: { chatLatencyMs: Date.now() - started, retrievalLatencyMs, requestId: ctx.requestId, gateway: { status: gatewayOutcome.status, providerId: gatewayOutcome.status === "returned" ? gatewayOutcome.providerId : undefined, failureReason: gatewayOutcome.status === "failed" ? gatewayOutcome.reason : undefined, attempts: gatewayOutcome.attempts.length } } };
    }),
    sendAsync: protectedProcedure.input(workspaceInput.extend({ conversationId: z.number().int().positive().optional(), message: z.string().trim().min(1).max(12000), language: z.enum(["en", "ta"]).default("en"), idempotencyKey: z.string().min(8).max(128).optional() })).mutation(async ({ ctx, input }) => {
      if (!asyncAnswersEnabled()) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Asynchronous answers are not enabled" });
      await requireWorkspace(ctx.user.id, input.workspaceId); const db = await getDb(); if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      let conversationId = input.conversationId;
      if (conversationId) { const owned = await db.select({ id: conversations.id }).from(conversations).where(and(eq(conversations.id, conversationId), eq(conversations.workspaceId, input.workspaceId), eq(conversations.userId, ctx.user.id))).limit(1); if (!owned[0]) throw new TRPCError({ code: "FORBIDDEN", message: "Conversation access denied" }); }
      if (!conversationId) { await db.insert(conversations).values({ workspaceId: input.workspaceId, userId: ctx.user.id, title: input.message.slice(0, 80), language: input.language }); const row = await db.select({ id: conversations.id }).from(conversations).where(and(eq(conversations.workspaceId, input.workspaceId), eq(conversations.userId, ctx.user.id))).orderBy(desc(conversations.id)).limit(1); conversationId = row[0]?.id; }
      if (!conversationId) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Conversation creation failed" });
      try {
        const { task } = await sharedTaskStore().create({ workspaceId: input.workspaceId, type: CHAT_ANSWER_TASK, input: { conversationId, userId: ctx.user.id, message: input.message, language: input.language }, idempotencyKey: input.idempotencyKey, maxAttempts: 3, createdByUserId: ctx.user.id });
        return { taskId: task.id, conversationId };
      } catch (error) { if (error instanceof TaskIdempotencyConflict) throw new TRPCError({ code: "CONFLICT", message: "Idempotency key reused with a different request" }); throw error; }
    }),
  }),
  connectors: router({
    mcp: router({
      list: protectedProcedure.input(workspaceInput).query(async ({ ctx, input }) => { await requireWorkspace(ctx.user.id, input.workspaceId); return sharedMcp().list(input.workspaceId); }),
      register: protectedProcedure.input(workspaceInput.extend({ name: z.string().min(1).max(96), endpoint: z.string().min(1).max(500), secretRef: z.string().max(64).optional(), allowedTools: z.array(z.string().max(128)).max(100).optional(), timeoutMs: z.number().int().optional(), maxResponseBytes: z.number().int().optional() })).mutation(async ({ ctx, input }) => { await requireWorkspaceOwner(ctx.user.id, input.workspaceId); const { workspaceId, ...rest } = input; return mcpGuard(() => sharedMcp().register({ workspaceId, userId: ctx.user.id }, rest)); }),
      setEnabled: protectedProcedure.input(workspaceInput.extend({ connectorId: z.string().uuid(), enabled: z.boolean() })).mutation(async ({ ctx, input }) => { await requireWorkspaceOwner(ctx.user.id, input.workspaceId); await mcpGuard(() => sharedMcp().setEnabled({ workspaceId: input.workspaceId, userId: ctx.user.id }, input.connectorId, input.enabled)); return { ok: true as const }; }),
      remove: protectedProcedure.input(workspaceInput.extend({ connectorId: z.string().uuid() })).mutation(async ({ ctx, input }) => { await requireWorkspaceOwner(ctx.user.id, input.workspaceId); await mcpGuard(() => sharedMcp().remove({ workspaceId: input.workspaceId, userId: ctx.user.id }, input.connectorId)); return { ok: true as const }; }),
      discover: protectedProcedure.input(workspaceInput.extend({ connectorId: z.string().uuid() })).mutation(async ({ ctx, input }) => { await requireWorkspace(ctx.user.id, input.workspaceId); return mcpGuard(() => sharedMcp().discover({ workspaceId: input.workspaceId, userId: ctx.user.id }, input.connectorId)); }),
      readResource: protectedProcedure.input(workspaceInput.extend({ connectorId: z.string().uuid(), uri: z.string().min(1).max(2048) })).mutation(async ({ ctx, input }) => { await requireWorkspace(ctx.user.id, input.workspaceId); return mcpGuard(() => sharedMcp().readResource({ workspaceId: input.workspaceId, userId: ctx.user.id }, input.connectorId, input.uri)); }),
      callTool: protectedProcedure.input(workspaceInput.extend({ connectorId: z.string().uuid(), tool: z.string().min(1).max(128), arguments: z.record(z.string(), z.unknown()).optional() })).mutation(async ({ ctx, input }) => { await requireWorkspace(ctx.user.id, input.workspaceId); return mcpGuard(() => sharedMcp().callTool({ workspaceId: input.workspaceId, userId: ctx.user.id }, input.connectorId, input.tool, input.arguments ?? {})); }),
      audit: protectedProcedure.input(workspaceInput.extend({ limit: z.number().int().min(1).max(500).optional() })).query(async ({ ctx, input }) => { await requireWorkspaceOwner(ctx.user.id, input.workspaceId); return new McpConnectorStore(getDb).listAudit(input.workspaceId, input.limit); }),
    }),
  }),
  tasks: router({
    get: protectedProcedure.input(workspaceInput.extend({ taskId: z.string().uuid() })).query(async ({ ctx, input }) => { await requireWorkspace(ctx.user.id, input.workspaceId); const task = await sharedTaskStore().get(input.workspaceId, input.taskId); if (!task) throw new TRPCError({ code: "NOT_FOUND", message: "Task not found" }); return toView(task); }),
    list: protectedProcedure.input(workspaceInput.extend({ state: z.enum(TASK_STATES).optional(), limit: z.number().int().min(1).max(200).optional() })).query(async ({ ctx, input }) => { await requireWorkspace(ctx.user.id, input.workspaceId); return (await sharedTaskStore().list(input.workspaceId, { state: input.state, limit: input.limit })).map(toView); }),
    cancel: protectedProcedure.input(workspaceInput.extend({ taskId: z.string().uuid() })).mutation(async ({ ctx, input }) => { await requireWorkspace(ctx.user.id, input.workspaceId); const task = await sharedTaskStore().cancel(input.workspaceId, input.taskId); if (!task) throw new TRPCError({ code: "NOT_FOUND", message: "Task not found" }); return toView(task); }),
  }),
});
export type AppRouter = typeof appRouter;
