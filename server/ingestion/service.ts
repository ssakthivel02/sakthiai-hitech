import { createHash } from "node:crypto";
import { createConfiguredMalwareScanner, inspectFileSafety, type MalwareScanner } from "../security/malwareScanner";
import { extractDocument, type ExtractedDocument } from "../provenance";
import type { UploadSession, UploadStore } from "./store";

export const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;
export const MIN_CHUNK_BYTES = 4 * 1024;
export const MAX_CHUNK_BYTES = 128 * 1024; // keeps base64 + envelope under the default 256 KiB edge body limit
export const MAX_ACTIVE_SESSIONS_PER_USER = 4;
export const MAX_ACTIVE_BYTES_PER_USER = 3 * MAX_UPLOAD_BYTES;
export const UPLOAD_TTL_SECONDS = 3600;
const ALLOWED_EXT = ["pdf", "docx", "txt", "text", "plain"];

export type IngestErrorCode = "DISABLED" | "INVALID" | "NOT_FOUND" | "CONFLICT" | "LIMIT" | "CLOSED" | "INCOMPLETE" | "INFECTED" | "SCANNER_UNAVAILABLE" | "DUPLICATE" | "EXTRACTION_FAILED" | "PROJECT_DENIED";
export class IngestError extends Error {
  constructor(public readonly code: IngestErrorCode, message: string) { super(message); this.name = "IngestError"; }
}
export type Actor = { workspaceId: number; userId: number };
export type CommitInput = { workspaceId: number; userId: number; projectId: number | null; filename: string; mimeType: string; buffer: Buffer; contentHash: string; extracted: ExtractedDocument };
export type Committer = (input: CommitInput) => Promise<{ documentId: number }>;
export type Extractor = (buffer: Buffer, mimeType: string, filename: string, clearedSha256: string) => Promise<ExtractedDocument>;
export type BeginInput = { projectId?: number | null; filename: string; mimeType: string; sizeBytes: number; sha256: string; chunkSize: number };
export type UploadStatus = { uploadId: string; state: UploadSession["state"]; totalChunks: number; chunkSize: number; received: number[]; missing: number[]; expiresAt: string; rejectReason: string | null; lastError: string | null; documentId: number | null };

/** Backend gate. Default OFF. The owner-approval gate that keeps the upload UI disabled stays authoritative; this only allows the API to be exercised. */
export const resumableIngestionEnabled = (env: NodeJS.ProcessEnv = process.env) => env.FILE_INGESTION_BACKEND_ENABLED === "true";

export const safeUploadFilename = (value: string) => value.normalize("NFKC").replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^\.+/, "").slice(0, 180) || "upload";
const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

/** A scanner view that vouches ONLY for the exact bytes this pipeline already scanned clean (defence in depth for extractDocument's own gate). */
const clearedBytesScanner = (clearedSha256: string): MalwareScanner => ({
  engine: "cleared-by-pipeline",
  async scan(buffer) { return sha256(buffer) === clearedSha256 ? { status: "clean", engine: "cleared-by-pipeline" } : { status: "error", engine: "cleared-by-pipeline", detail: "bytes_changed_after_scan" }; },
});
export const defaultExtractor: Extractor = (buffer, mimeType, filename, clearedSha256) => extractDocument(buffer, mimeType, { filename, scanner: clearedBytesScanner(clearedSha256) });

export function validateFileShape(buffer: Buffer, mimeType: string, filename: string): void {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  if (!ALLOWED_EXT.includes(ext)) throw new IngestError("INVALID", "Unsupported file extension");
  if (ext === "pdf" && buffer.subarray(0, 5).toString() !== "%PDF-") throw new IngestError("INVALID", "File content is not a valid PDF");
  if (ext === "docx" && buffer.subarray(0, 2).toString() !== "PK") throw new IngestError("INVALID", "File content is not a valid DOCX");
  if (mimeType.length > 160) throw new IngestError("INVALID", "Invalid MIME type");
}

export type ServiceDeps = {
  store: UploadStore; commit: Committer; extract?: Extractor; scanner?: () => MalwareScanner | null; env?: NodeJS.ProcessEnv;
  projectAllowed?: (workspaceId: number, projectId: number) => Promise<boolean>;
};

/**
 * assemble -> size/checksum validation -> shape validation -> malware scan -> clean decision -> extraction -> normal storage.
 * Chunks live only in the quarantine table until the scan returns CLEAN. Infected, errored or unavailable scans never reach
 * extraction, object storage, documents or retrieval.
 */
export class ResumableIngestion {
  private readonly extract: Extractor; private readonly scanner: () => MalwareScanner | null; private readonly env: NodeJS.ProcessEnv;
  constructor(private readonly deps: ServiceDeps) {
    this.extract = deps.extract ?? defaultExtractor; this.scanner = deps.scanner ?? (() => createConfiguredMalwareScanner(this.env)); this.env = deps.env ?? process.env;
  }
  private gate() { if (!resumableIngestionEnabled(this.env)) throw new IngestError("DISABLED", "Resumable file ingestion is not enabled"); }
  private async session(actor: Actor, id: string): Promise<UploadSession> {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new IngestError("NOT_FOUND", "Upload not found");
    const s = await this.deps.store.get(actor.workspaceId, actor.userId, id);
    if (!s) throw new IngestError("NOT_FOUND", "Upload not found");
    return s;
  }

  async begin(actor: Actor, input: BeginInput): Promise<UploadStatus> {
    this.gate();
    const filename = safeUploadFilename(input.filename);
    if (!Number.isInteger(input.sizeBytes) || input.sizeBytes < 1 || input.sizeBytes > MAX_UPLOAD_BYTES) throw new IngestError("INVALID", input.sizeBytes > MAX_UPLOAD_BYTES ? "File exceeds 12MB limit" : "Empty or invalid size");
    if (!/^[0-9a-f]{64}$/.test(input.sha256)) throw new IngestError("INVALID", "sha256 must be 64 lowercase hex characters");
    if (!Number.isInteger(input.chunkSize) || input.chunkSize < MIN_CHUNK_BYTES || input.chunkSize > MAX_CHUNK_BYTES) throw new IngestError("INVALID", `chunkSize must be ${MIN_CHUNK_BYTES}-${MAX_CHUNK_BYTES}`);
    const ext = filename.toLowerCase().split(".").pop() ?? "";
    if (!ALLOWED_EXT.includes(ext)) throw new IngestError("INVALID", "Unsupported file extension");
    if (input.mimeType.length < 1 || input.mimeType.length > 160) throw new IngestError("INVALID", "Invalid MIME type");
    if (input.projectId != null && !(await (this.deps.projectAllowed?.(actor.workspaceId, input.projectId) ?? Promise.resolve(true)))) throw new IngestError("PROJECT_DENIED", "Project access denied");
    const active = await this.deps.store.countActive(actor.workspaceId, actor.userId);
    if (active.sessions >= MAX_ACTIVE_SESSIONS_PER_USER || active.bytes + input.sizeBytes > MAX_ACTIVE_BYTES_PER_USER) throw new IngestError("LIMIT", "Too many active uploads");
    const created = await this.deps.store.create({ workspaceId: actor.workspaceId, userId: actor.userId, projectId: input.projectId ?? null, filename, mimeType: input.mimeType, declaredBytes: input.sizeBytes, declaredSha256: input.sha256, chunkSize: input.chunkSize, totalChunks: Math.ceil(input.sizeBytes / input.chunkSize) }, UPLOAD_TTL_SECONDS);
    return this.statusOf(created);
  }

  async putChunk(actor: Actor, uploadId: string, index: number, data: Buffer, declaredSha256?: string): Promise<{ stored: "stored" | "duplicate"; received: number }> {
    this.gate();
    const s = await this.session(actor, uploadId);
    if (s.state !== "OPEN") throw new IngestError("CLOSED", `Upload is ${s.state.toLowerCase()}`);
    if (!Number.isInteger(index) || index < 0 || index >= s.totalChunks) throw new IngestError("INVALID", "Chunk index out of range");
    const expected = index === s.totalChunks - 1 ? s.declaredBytes - s.chunkSize * (s.totalChunks - 1) : s.chunkSize;
    if (data.length !== expected) throw new IngestError("INVALID", `Chunk ${index} must be exactly ${expected} bytes`);
    const digest = sha256(data);
    if (declaredSha256 && declaredSha256 !== digest) throw new IngestError("INVALID", "Chunk checksum mismatch");
    const result = await this.deps.store.putChunk(s, index, digest, data);
    if (result === "conflict") throw new IngestError("CONFLICT", `Chunk ${index} was already uploaded with different content`);
    if (result === "closed") throw new IngestError("CLOSED", "Upload is closed");
    return { stored: result, received: (await this.deps.store.receivedIndexes(s.id)).length };
  }

  async status(actor: Actor, uploadId: string): Promise<UploadStatus> { this.gate(); return this.statusOf(await this.session(actor, uploadId)); }
  private async statusOf(s: UploadSession): Promise<UploadStatus> {
    const received = await this.deps.store.receivedIndexes(s.id);
    const have = new Set(received);
    return { uploadId: s.id, state: s.state, totalChunks: s.totalChunks, chunkSize: s.chunkSize, received, missing: Array.from({ length: s.totalChunks }, (_, i) => i).filter(i => !have.has(i)), expiresAt: s.expiresAt.toISOString(), rejectReason: s.rejectReason, lastError: s.lastError, documentId: s.documentId };
  }
  async abort(actor: Actor, uploadId: string): Promise<{ aborted: boolean }> { this.gate(); return { aborted: await this.deps.store.abort(await this.session(actor, uploadId)) }; }

  async finalize(actor: Actor, uploadId: string): Promise<{ documentId: number; filename: string; scanner: "clean"; bytes: number; contentHash: string }> {
    this.gate();
    const s = await this.session(actor, uploadId);
    if (s.state === "COMPLETED" && s.documentId != null) return { documentId: s.documentId, filename: s.filename, scanner: "clean", bytes: s.declaredBytes, contentHash: s.declaredSha256 };
    if (s.state === "REJECTED") throw new IngestError(s.rejectReason === "INFECTED" ? "INFECTED" : s.rejectReason === "DUPLICATE" ? "DUPLICATE" : "INVALID", `Upload rejected: ${s.rejectReason ?? "unknown"}`);
    if (s.state === "FINALIZING") throw new IngestError("CONFLICT", "Upload is being finalized elsewhere");
    if (s.state !== "OPEN") throw new IngestError("CLOSED", `Upload is ${s.state.toLowerCase()}`);
    // Completeness is checked BEFORE taking the finalize lock so a premature call is harmless and retryable.
    const meta = await this.deps.store.chunkMeta(s.id);
    if (meta.length !== s.totalChunks) throw new IngestError("INCOMPLETE", `Missing chunks: ${s.totalChunks - meta.length}`);
    if (!(await this.deps.store.beginFinalize(s))) throw new IngestError("CONFLICT", "Upload is being finalized elsewhere or has expired");

    try {
      // 1. assemble (in memory only; never written to a filesystem path or object storage)
      const parts: Buffer[] = [];
      for (let i = 0; i < s.totalChunks; i += 1) { const part = await this.deps.store.readChunk(s.id, i); if (!part) { await this.deps.store.backToOpen(s.id, "chunk_missing"); throw new IngestError("INCOMPLETE", `Chunk ${i} missing`); } parts.push(part); }
      const buffer = Buffer.concat(parts);
      // 2. size + checksum
      const contentHash = sha256(buffer);
      if (buffer.length !== s.declaredBytes || contentHash !== s.declaredSha256) { await this.deps.store.reject(s.id, "CHECKSUM_MISMATCH"); throw new IngestError("INVALID", "Assembled file does not match declared size/checksum"); }
      try { validateFileShape(buffer, s.mimeType, s.filename); } catch (error) { await this.deps.store.reject(s.id, "INVALID_SHAPE"); throw error; }
      // 3. malware scan (fail closed)
      const decision = await inspectFileSafety(buffer, { filename: s.filename, mimeType: s.mimeType }, this.scanner());
      const scan = { status: decision.scanner.status, engine: decision.scanner.engine };
      if (decision.disposition !== "allow") {
        if (decision.scanner.status === "infected") { await this.deps.store.reject(s.id, "INFECTED", scan); throw new IngestError("INFECTED", "Upload quarantined by malware policy"); }
        await this.deps.store.backToOpen(s.id, `scanner_${decision.scanner.status}`, scan); // bytes stay quarantined; retry later
        throw new IngestError("SCANNER_UNAVAILABLE", "Malware scanner unavailable; upload blocked");
      }
      // 4. clean decision -> extraction -> 5. normal storage
      let extracted: ExtractedDocument;
      try { extracted = await this.extract(buffer, s.mimeType, s.filename, contentHash); if (!extracted.text) throw new Error("no text"); }
      catch { await this.deps.store.reject(s.id, "EXTRACTION_FAILED", scan); throw new IngestError("EXTRACTION_FAILED", "No extractable text"); }
      let committed: { documentId: number };
      try { committed = await this.deps.commit({ workspaceId: s.workspaceId, userId: s.userId, projectId: s.projectId, filename: s.filename, mimeType: s.mimeType, buffer, contentHash, extracted }); }
      catch (error) {
        if (error instanceof IngestError && error.code === "DUPLICATE") { await this.deps.store.reject(s.id, "DUPLICATE", scan); throw error; }
        await this.deps.store.backToOpen(s.id, "commit_failed", scan); throw error; // transient storage/DB failure: retryable
      }
      await this.deps.store.complete(s.id, committed.documentId, scan);
      return { documentId: committed.documentId, filename: s.filename, scanner: "clean", bytes: buffer.length, contentHash };
    } catch (error) {
      if (error instanceof IngestError) throw error;
      // Unexpected failure: release the finalize lock so the (still quarantined) upload can be retried or expire.
      await this.deps.store.backToOpen(s.id, "finalize_error").catch(() => undefined);
      throw error;
    }
  }
}
