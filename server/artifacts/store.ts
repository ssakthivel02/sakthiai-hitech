import { createHash } from "node:crypto";
import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/mysql2";
import { artifacts, conversations, messages, projects, type Citation } from "../../drizzle/schema";
import { INSUFFICIENT_EVIDENCE_SENTINEL, modelUnavailableMessage } from "../grounding";
import { crossScriptTag, isLowInformationQuery, normalizeRetrievalTerms, normalizeRetrievalText, scoreRetrievalCandidate } from "../retrieval";
import { likePattern, MAX_QUERY_TERMS, searchTextFor } from "../retrievalStore";

/**
 * Persistent workspace artifacts (a grounded chat answer + the evidence it was grounded on).
 *
 * Security model (fail closed):
 *  - The caller (router) has already proven workspace membership; EVERY query here is additionally scoped by workspaceId
 *    in SQL, so an id from another workspace is indistinguishable from a missing row.
 *  - saveFromMessage takes only ids. Content and citations are read from the stored assistant message, never from the
 *    client, so evidence cannot be forged. The saver must own the source conversation (same rule as chat.history).
 *  - Only genuinely grounded answers can be saved: >= 1 citation AND not a system fallback. INSUFFICIENT_EVIDENCE and the
 *    MODEL_UNAVAILABLE notice (which is persisted WITH citations, so citations alone cannot tell it apart) are refused.
 */
type Db = ReturnType<typeof drizzle>;

export const ARTIFACT_KINDS = ["chat_answer"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];
export const MAX_ARTIFACT_CONTENT_CHARS = 50_000;
export const MAX_ARTIFACT_TITLE_CODE_POINTS = 180;
export const DEFAULT_ARTIFACT_TITLE = "Saved answer";
/** Candidate rows pulled from SQL before ranking in JS (bounded; content is up to MAX_ARTIFACT_CONTENT_CHARS each). */
export const ARTIFACT_SEARCH_CANDIDATE_LIMIT = 100;
const SNIPPET_CODE_POINTS = 240;

export type ArtifactErrorCode = "CONVERSATION_DENIED" | "MESSAGE_NOT_FOUND" | "NOT_SAVEABLE" | "TOO_LARGE" | "PROJECT_DENIED" | "NOT_FOUND" | "MODIFY_DENIED" | "INVALID";
export class ArtifactError extends Error {
  constructor(readonly code: ArtifactErrorCode, message: string) { super(message); this.name = "ArtifactError"; }
}

export type ArtifactSummary = {
  id: number; projectId: number | null; kind: string; title: string; language: "en" | "ta";
  createdByUserId: number; sourceConversationId: number | null; sourceMessageId: number | null; createdAt: Date; updatedAt: Date;
};
export type ArtifactView = ArtifactSummary & { content: string; citations: Citation[] };
export type ArtifactHit = Pick<ArtifactSummary, "id" | "projectId" | "kind" | "title" | "language" | "updatedAt"> & { score: number; retrievalMethod: "lexical"; snippet: string };

// ---- pure helpers (unit-testable without a database) ----

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const codePointLength = (text: string) => Array.from(text).length;
/** Cuts on grapheme boundaries (never between a Tamil consonant and its vowel sign / virama) within a code-point budget. */
export function truncateText(text: string, maxCodePoints: number): string {
  let used = 0; let out = "";
  for (const { segment } of graphemes.segment(text)) {
    const cost = codePointLength(segment);
    if (used + cost > maxCodePoints) return out.trimEnd();
    out += segment; used += cost;
  }
  return out;
}
/** Single-line excerpt within a code-point budget, ending in an ellipsis when cut. */
export const excerptText = (text: string, max: number) => (codePointLength(text) <= max ? text : `${truncateText(text, max - 1)}…`);
const withEllipsis = excerptText;

/** Controls, bidi overrides/isolates, line/paragraph separators, BOM and zero-width space. ZWJ/ZWNJ are kept: Indic scripts use them. */
const TITLE_STRIP = /[\u0000-\u001F\u007F-\u009F\u200B\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/g;
export function sanitizeTitle(raw: string): string {
  return truncateText(raw.replace(TITLE_STRIP, " ").replace(/\s+/g, " ").trim(), MAX_ARTIFACT_TITLE_CODE_POINTS);
}
export function deriveArtifactTitle(content: string): string {
  const firstLine = content.split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? "";
  const plain = firstLine.replace(/^(#{1,6}|>|[-*+]|\d+[.)])\s+/, "").replace(/\*\*|__|`/g, "");
  return sanitizeTitle(plain) || DEFAULT_ARTIFACT_TITLE;
}

/**
 * True only for a real model answer grounded on evidence. The MODEL_UNAVAILABLE notice is a deterministic server string
 * persisted together with the retrieved citations (grounding.ts), so it is recognised by exact text in either language.
 */
export function isSaveableAnswer(content: string, citations: readonly unknown[]): boolean {
  const text = content.trim();
  if (!text || citations.length === 0 || text === INSUFFICIENT_EVIDENCE_SENTINEL) return false;
  return !(["en", "ta"] as const).some(language => modelUnavailableMessage(language, citations.length) === text);
}

/** Defensive parse of stored evidence: anything that is not a well-formed citation is dropped, never rendered. */
export function parseCitations(json: string | null | undefined): Citation[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is Citation => {
      if (!item || typeof item !== "object") return false;
      const c = item as Record<string, unknown>;
      return typeof c.filename === "string" && typeof c.excerpt === "string" && typeof c.documentId === "number" && Number.isFinite(c.documentId);
    });
  } catch { return []; }
}

/** The paragraph with the most query-term hits (normalized on both sides), cut on grapheme boundaries. */
export function snippetFor(content: string, terms: string[], max = SNIPPET_CODE_POINTS): string {
  const paragraphs = content.split(/\n+/).map(p => p.replace(/\s+/g, " ").trim()).filter(Boolean);
  let best = paragraphs[0] ?? "";
  let bestHits = -1;
  for (const paragraph of paragraphs) {
    const normalized = normalizeRetrievalText(paragraph);
    const hits = terms.reduce((count, term) => count + (normalized.includes(term) ? 1 : 0), 0);
    if (hits > bestHits) { best = paragraph; bestHits = hits; }
  }
  return withEllipsis(best, max);
}

type RankRow = Pick<ArtifactSummary, "id" | "projectId" | "kind" | "title" | "language" | "updatedAt"> & { content: string };
/**
 * Lexical ranking with the SAME normalization, Tamil/Tanglish handling and scorer as chunk retrieval (no new relevance
 * model). Stopword-only queries return nothing. Ties: newer artifact (higher id) first, so ordering is deterministic.
 * Artifacts are not embedded in this slice, so retrievalMethod is always "lexical" (never claims semantic).
 */
export function rankArtifactCandidates(rows: RankRow[], query: string, limit = 20): ArtifactHit[] {
  if (isLowInformationQuery(query)) return [];
  const terms = normalizeRetrievalTerms(query).slice(0, MAX_QUERY_TERMS);
  if (!terms.length) return [];
  return rows
    .map(row => ({ row, score: scoreRetrievalCandidate({ content: `${row.title}\n${row.content}`, terms, queryVector: null, candidateVector: null }).score }))
    .filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score || b.row.id - a.row.id)
    .slice(0, limit)
    .map(({ row, score }) => ({ id: row.id, projectId: row.projectId, kind: row.kind, title: row.title, language: row.language, updatedAt: row.updatedAt, score: Number(score.toFixed(6)), retrievalMethod: "lexical" as const, snippet: snippetFor(row.content, terms) }));
}

/** Auto-increment id from a mysql2 insert result ([ResultSetHeader, ...]); undefined when the driver gives none. */
export function insertedId(result: unknown): number | undefined {
  const id = (result as [{ insertId?: unknown }?] | null | undefined)?.[0]?.insertId;
  return typeof id === "number" && Number.isInteger(id) && id > 0 ? id : undefined;
}

const isDuplicateKey = (error: unknown) => {
  const e = error as { code?: string; errno?: number; cause?: { code?: string; errno?: number } } | null;
  return e?.code === "ER_DUP_ENTRY" || e?.errno === 1062 || e?.cause?.code === "ER_DUP_ENTRY" || e?.cause?.errno === 1062;
};

// ---- persistence ----

const summaryColumns = {
  id: artifacts.id, projectId: artifacts.projectId, kind: artifacts.kind, title: artifacts.title, language: artifacts.language,
  createdByUserId: artifacts.createdByUserId, sourceConversationId: artifacts.sourceConversationId, sourceMessageId: artifacts.sourceMessageId,
  createdAt: artifacts.createdAt, updatedAt: artifacts.updatedAt,
};
const toView = (row: ArtifactSummary & { content: string; citationsJson: string | null }): ArtifactView => {
  const { citationsJson, ...rest } = row;
  return { ...rest, citations: parseCitations(citationsJson) };
};

async function findBySourceMessage(db: Db, workspaceId: number, messageId: number): Promise<ArtifactView | null> {
  const rows = await db.select({ ...summaryColumns, content: artifacts.content, citationsJson: artifacts.citationsJson }).from(artifacts)
    .where(and(eq(artifacts.workspaceId, workspaceId), eq(artifacts.sourceMessageId, messageId))).limit(1);
  return rows[0] ? toView(rows[0]) : null;
}

export async function createArtifactFromMessage(db: Db, input: { workspaceId: number; userId: number; conversationId: number; messageId: number; projectId?: number; title?: string }): Promise<{ artifact: ArtifactView; created: boolean }> {
  const conversation = (await db.select({ id: conversations.id, language: conversations.language }).from(conversations)
    .where(and(eq(conversations.id, input.conversationId), eq(conversations.workspaceId, input.workspaceId), eq(conversations.userId, input.userId))).limit(1))[0];
  if (!conversation) throw new ArtifactError("CONVERSATION_DENIED", "Conversation access denied");

  const message = (await db.select().from(messages)
    .where(and(eq(messages.id, input.messageId), eq(messages.conversationId, input.conversationId), eq(messages.workspaceId, input.workspaceId), eq(messages.role, "assistant"))).limit(1))[0];
  if (!message) throw new ArtifactError("MESSAGE_NOT_FOUND", "Assistant message not found in this conversation");

  const content = message.content.trim();
  const citations = parseCitations(message.citationsJson);
  if (!isSaveableAnswer(content, citations)) throw new ArtifactError("NOT_SAVEABLE", "Only grounded answers with citations can be saved");
  if (content.length > MAX_ARTIFACT_CONTENT_CHARS) throw new ArtifactError("TOO_LARGE", "Answer is too large to save as an artifact");

  if (input.projectId !== undefined) {
    const project = await db.select({ id: projects.id }).from(projects).where(and(eq(projects.id, input.projectId), eq(projects.workspaceId, input.workspaceId))).limit(1);
    if (!project[0]) throw new ArtifactError("PROJECT_DENIED", "Project access denied");
  }

  const existing = await findBySourceMessage(db, input.workspaceId, input.messageId);
  if (existing) return { artifact: existing, created: false };

  const title = sanitizeTitle(input.title ?? "") || deriveArtifactTitle(content);
  try {
    await db.insert(artifacts).values({
      workspaceId: input.workspaceId, projectId: input.projectId ?? null, createdByUserId: input.userId, kind: "chat_answer", title,
      language: conversation.language, content, contentHash: createHash("sha256").update(content).digest("hex"),
      citationsJson: JSON.stringify(citations), sourceConversationId: input.conversationId, sourceMessageId: input.messageId,
      searchText: searchTextFor(`${title}\n${content}`),
    });
  } catch (error) {
    // A concurrent identical save won the unique (workspaceId, sourceMessageId) key: idempotent, return the winner.
    if (isDuplicateKey(error)) { const winner = await findBySourceMessage(db, input.workspaceId, input.messageId); if (winner) return { artifact: winner, created: false }; }
    throw error;
  }
  const saved = await findBySourceMessage(db, input.workspaceId, input.messageId);
  if (!saved) throw new Error("Artifact persistence failed");
  return { artifact: saved, created: true };
}

export async function listArtifacts(db: Db, workspaceId: number, options: { projectId?: number; limit?: number } = {}): Promise<ArtifactSummary[]> {
  const where = options.projectId === undefined ? eq(artifacts.workspaceId, workspaceId) : and(eq(artifacts.workspaceId, workspaceId), eq(artifacts.projectId, options.projectId));
  return db.select(summaryColumns).from(artifacts).where(where).orderBy(desc(artifacts.updatedAt), desc(artifacts.id)).limit(Math.max(1, Math.min(options.limit ?? 50, 200)));
}

export async function getArtifact(db: Db, workspaceId: number, id: number): Promise<ArtifactView | null> {
  const rows = await db.select({ ...summaryColumns, content: artifacts.content, citationsJson: artifacts.citationsJson }).from(artifacts)
    .where(and(eq(artifacts.workspaceId, workspaceId), eq(artifacts.id, id))).limit(1);
  return rows[0] ? toView(rows[0]) : null;
}

/** Workspace-scoped, DB-prefiltered lexical search (bounded candidate set) ranked by rankArtifactCandidates. */
export async function searchArtifacts(db: Db, workspaceId: number, query: string, limit = 20): Promise<ArtifactHit[]> {
  if (isLowInformationQuery(query)) return [];
  const terms = normalizeRetrievalTerms(query).slice(0, MAX_QUERY_TERMS);
  if (!terms.length) return [];
  const matches: SQL[] = terms.map(term => sql`(${artifacts.searchText} COLLATE utf8mb4_bin LIKE ${likePattern(term)} ESCAPE '!')`);
  // Cross-script (Tamil <-> Tanglish) candidates: space-delimited script-tagged keys appended to searchText at index time.
  const tags = [...new Set(terms.map(crossScriptTag).filter((tag): tag is string => !!tag))].slice(0, MAX_QUERY_TERMS);
  for (const tag of tags) matches.push(sql`(${artifacts.searchText} COLLATE utf8mb4_bin LIKE ${likePattern(` ${tag} `)} ESCAPE '!')`);
  const hits = sql.join(matches, sql` + `);
  const rows = await db.select({ id: artifacts.id, projectId: artifacts.projectId, kind: artifacts.kind, title: artifacts.title, language: artifacts.language, updatedAt: artifacts.updatedAt, content: artifacts.content })
    .from(artifacts)
    .where(and(eq(artifacts.workspaceId, workspaceId), sql`(${hits}) > 0`))
    .orderBy(desc(hits), desc(artifacts.id))
    .limit(ARTIFACT_SEARCH_CANDIDATE_LIMIT);
  return rankArtifactCandidates(rows, query, limit);
}

// ---- lifecycle: rename / move / delete ----

/** Who may change an artifact: the member who saved it, or a workspace owner. Plain members can read everything but cannot alter others' artifacts. */
export type ArtifactActor = { userId: number; isWorkspaceOwner: boolean };
async function loadManageable(db: Db, workspaceId: number, actor: ArtifactActor, artifactId: number) {
  const row = (await db.select({ id: artifacts.id, createdByUserId: artifacts.createdByUserId, content: artifacts.content }).from(artifacts)
    .where(and(eq(artifacts.workspaceId, workspaceId), eq(artifacts.id, artifactId))).limit(1))[0];
  if (!row) throw new ArtifactError("NOT_FOUND", "Artifact not found");
  if (row.createdByUserId !== actor.userId && !actor.isWorkspaceOwner) throw new ArtifactError("MODIFY_DENIED", "Only the member who saved this artifact or a workspace owner can change it");
  return row;
}

/**
 * Renames and/or moves an artifact. projectId: a number moves it into that (same-workspace) project, null removes it from its project,
 * undefined leaves it. Evidence, content and provenance are never editable here. A rename re-indexes searchText so search follows the title.
 */
export async function updateArtifact(db: Db, input: { workspaceId: number; actor: ArtifactActor; artifactId: number; title?: string; projectId?: number | null }): Promise<ArtifactView> {
  if (input.title === undefined && input.projectId === undefined) throw new ArtifactError("INVALID", "Nothing to change");
  const row = await loadManageable(db, input.workspaceId, input.actor, input.artifactId);
  const changes: { title?: string; searchText?: string; projectId?: number | null } = {};
  if (input.title !== undefined) {
    const title = sanitizeTitle(input.title);
    if (!title) throw new ArtifactError("INVALID", "Title cannot be empty");
    changes.title = title;
    changes.searchText = searchTextFor(`${title}\n${row.content}`);
  }
  if (input.projectId !== undefined) {
    if (input.projectId !== null) {
      const project = await db.select({ id: projects.id }).from(projects).where(and(eq(projects.id, input.projectId), eq(projects.workspaceId, input.workspaceId))).limit(1);
      if (!project[0]) throw new ArtifactError("PROJECT_DENIED", "Project access denied");
    }
    changes.projectId = input.projectId;
  }
  await db.update(artifacts).set(changes).where(and(eq(artifacts.workspaceId, input.workspaceId), eq(artifacts.id, input.artifactId)));
  const updated = await getArtifact(db, input.workspaceId, input.artifactId);
  if (!updated) throw new ArtifactError("NOT_FOUND", "Artifact not found");
  return updated;
}

/** Permanently deletes the artifact row only. The source conversation, message and uploaded files are untouched; the same answer can be saved again. */
export async function deleteArtifact(db: Db, input: { workspaceId: number; actor: ArtifactActor; artifactId: number }): Promise<{ deleted: true }> {
  await loadManageable(db, input.workspaceId, input.actor, input.artifactId);
  await db.delete(artifacts).where(and(eq(artifacts.workspaceId, input.workspaceId), eq(artifacts.id, input.artifactId)));
  return { deleted: true };
}
