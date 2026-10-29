import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/mysql2";
import { documentChunks, documents, users, workspaces } from "../../drizzle/schema";
import { isSessionUserAllowed, type LoginAccessPolicy } from "../_core/authAccess";
import { extractDocument } from "../provenance";
import { searchTextFor } from "../retrievalStore";
import type { MalwareScanner } from "../security/malwareScanner";

/**
 * OPERATOR-ONLY import of the approved SYNTHETIC English/Tamil beta sources into designated beta workspaces.
 *
 * Not reachable from the app: no tRPC procedure, no Express route, no startup hook imports this module
 * (enforced by server/ops/betaSourceImport.static.test.ts). It runs only from scripts/import-beta-sources.ts,
 * dry-run by default, and writes only with an explicit token bound to the corpus bytes, the workspace ids and
 * the target database name.
 *
 * Safety properties:
 *  - Tenant scoping: every write carries the target workspaceId; a workspace is "designated" only when it exists AND
 *    its owner passes the LOGIN ALLOWLIST (mode must be exactly "allowlist"; open/closed policies are refused).
 *    Any non-designated or unknown workspace fails the WHOLE plan before the first write.
 *  - Idempotent: keyed on (workspaceId, contentHash), the same key the normal upload path de-duplicates on.
 *    Each document + its chunks commit in one transaction under a per-workspace row lock held until commit.
 *  - Synthetic-only: the manifest must say synthetic:true, every file must be hash-pinned, size-bounded, carry the
 *    SYNTHETIC marker, match its declared language and use the synthetic-*.txt name pattern.
 *  - No network, no embeddings, no object storage (storageKey stays NULL; chat never reads storage).
 */

export const SYNTHETIC_MARKER = "SYNTHETIC TEST DOCUMENT";
export const MANIFEST_SCHEMA_VERSION = "1";
export const MAX_DOCUMENTS = 20;
export const MAX_DOCUMENT_BYTES = 64 * 1024;
export const MAX_WORKSPACES_PER_RUN = 5;
const FILENAME_PATTERN = /^synthetic-[a-z0-9-]+\.txt$/;
const TAMIL = /[஀-௿]/;

type Db = ReturnType<typeof drizzle>;

export type CorpusDocument = { file: string; filename: string; language: "en" | "ta"; mimeType: "text/plain"; sha256: string; bytes: Buffer };
export type LoadedCorpus = { corpusId: string; manifestSha256: string; documents: CorpusDocument[] };

export class ImportRefusal extends Error {
  constructor(message: string, readonly reasons: string[] = []) { super(message); this.name = "ImportRefusal"; }
}

const sha256Hex = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

export async function loadCorpus(dir: string): Promise<LoadedCorpus> {
  const manifestBytes = await readFile(path.join(dir, "manifest.json"));
  let manifest: Record<string, unknown>;
  try { manifest = JSON.parse(manifestBytes.toString("utf8")); } catch { throw new ImportRefusal("manifest.json is not valid JSON"); }
  const problems: string[] = [];
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) problems.push("unsupported schemaVersion");
  if (manifest.synthetic !== true) problems.push("manifest must declare synthetic:true");
  if (typeof manifest.corpusId !== "string" || !/^[a-z0-9][a-z0-9-]{2,63}$/.test(manifest.corpusId)) problems.push("invalid corpusId");
  const entries = Array.isArray(manifest.documents) ? (manifest.documents as Array<Record<string, unknown>>) : [];
  if (!entries.length) problems.push("manifest lists no documents");
  if (entries.length > MAX_DOCUMENTS) problems.push(`more than ${MAX_DOCUMENTS} documents`);
  if (problems.length) throw new ImportRefusal("manifest rejected", problems);

  const documentsOut: CorpusDocument[] = [];
  const seenNames = new Set<string>();
  const seenHashes = new Set<string>();
  for (const entry of entries) {
    const label = String(entry.file ?? "?");
    const file = typeof entry.file === "string" ? entry.file : "";
    if (!FILENAME_PATTERN.test(file) || file !== path.basename(file)) { problems.push(`${label}: file name must match synthetic-*.txt and carry no path`); continue; }
    if (entry.filename !== file) { problems.push(`${label}: filename must equal file`); continue; }
    if (entry.mimeType !== "text/plain") { problems.push(`${label}: mimeType must be text/plain`); continue; }
    if (entry.language !== "en" && entry.language !== "ta") { problems.push(`${label}: language must be en or ta`); continue; }
    if (typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256)) { problems.push(`${label}: sha256 missing or malformed`); continue; }
    let bytes: Buffer;
    try { bytes = await readFile(path.join(dir, file)); } catch { problems.push(`${label}: file missing`); continue; }
    if (sha256Hex(bytes) !== entry.sha256) { problems.push(`${label}: sha256 does not match the file`); continue; }
    if (!bytes.length || bytes.length > MAX_DOCUMENT_BYTES) { problems.push(`${label}: size out of bounds`); continue; }
    const text = bytes.toString("utf8");
    if (!text.startsWith(SYNTHETIC_MARKER)) { problems.push(`${label}: missing SYNTHETIC marker`); continue; }
    const hasTamil = TAMIL.test(text);
    if (entry.language === "ta" && !hasTamil) { problems.push(`${label}: declared Tamil but contains no Tamil text`); continue; }
    if (entry.language === "en" && hasTamil) { problems.push(`${label}: declared English but contains Tamil text`); continue; }
    if (seenNames.has(file) || seenHashes.has(entry.sha256)) { problems.push(`${label}: duplicate document`); continue; }
    seenNames.add(file); seenHashes.add(entry.sha256);
    documentsOut.push({ file, filename: file, language: entry.language, mimeType: "text/plain", sha256: entry.sha256, bytes });
  }
  if (problems.length) throw new ImportRefusal("corpus rejected", problems);
  return { corpusId: manifest.corpusId as string, manifestSha256: sha256Hex(manifestBytes), documents: documentsOut };
}

/** Binds an apply to the exact corpus bytes, the exact workspaces and the exact database. Not a secret: an intent check. */
export function confirmationToken(corpus: Pick<LoadedCorpus, "corpusId" | "manifestSha256">, workspaceIds: number[], databaseName: string): string {
  const ids = [...new Set(workspaceIds)].sort((a, b) => a - b).join(",");
  return `IMPORT-${sha256Hex(`${corpus.corpusId}|${corpus.manifestSha256}|${ids}|${databaseName}`).slice(0, 16).toUpperCase()}`;
}

export type WorkspacePlan = { workspaceId: number; name: string; ownerUserId: number; toInsert: string[]; alreadyPresent: string[] };
export type ImportPlan = { ok: boolean; reasons: string[]; databaseName: string; workspaces: WorkspacePlan[] };

export async function currentDatabaseName(db: Db): Promise<string> {
  const [rows] = (await db.execute(sql`SELECT DATABASE() AS name`)) as unknown as [Array<{ name: string | null }>];
  return rows[0]?.name ?? "";
}

/** Read-only. Never writes. Any problem makes the whole plan not ok, so apply refuses before its first write. */
export async function planImport(input: { db: Db; corpus: LoadedCorpus; workspaceIds: number[]; policy: LoginAccessPolicy }): Promise<ImportPlan> {
  const { db, corpus, policy } = input;
  const reasons: string[] = [];
  const databaseName = await currentDatabaseName(db);
  if (!databaseName) reasons.push("no database selected");
  const ids = input.workspaceIds;
  if (!ids.length) reasons.push("no workspace designated; pass --workspace-id");
  if (ids.length > MAX_WORKSPACES_PER_RUN) reasons.push(`at most ${MAX_WORKSPACES_PER_RUN} workspaces per run`);
  if (new Set(ids).size !== ids.length) reasons.push("duplicate workspace id");
  if (ids.some(id => !Number.isInteger(id) || id <= 0)) reasons.push("workspace ids must be positive integers");
  if (policy.mode !== "allowlist") reasons.push(`login policy mode is "${policy.mode}"; designated beta workspaces require an explicit allowlist (AUTH_ALLOWED_SUBJECTS / AUTH_ALLOWED_EMAILS / OWNER_OPEN_ID) and no open signup`);
  const plans: WorkspacePlan[] = [];
  if (!reasons.length) {
    for (const workspaceId of ids) {
      const rows = await db.select({ id: workspaces.id, name: workspaces.name, ownerUserId: workspaces.ownerUserId }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
      const workspace = rows[0];
      if (!workspace) { reasons.push(`workspace ${workspaceId}: not found`); continue; }
      const owners = await db.select({ openId: users.openId, email: users.email }).from(users).where(eq(users.id, workspace.ownerUserId)).limit(1);
      const owner = owners[0];
      if (!owner || !isSessionUserAllowed(policy, owner)) { reasons.push(`workspace ${workspaceId}: owner is not on the beta allowlist (not a designated beta workspace)`); continue; }
      const present = await db.select({ contentHash: documents.contentHash }).from(documents).where(eq(documents.workspaceId, workspaceId));
      const have = new Set(present.map(row => row.contentHash));
      plans.push({
        workspaceId, name: workspace.name, ownerUserId: workspace.ownerUserId,
        toInsert: corpus.documents.filter(doc => !have.has(doc.sha256)).map(doc => doc.filename),
        alreadyPresent: corpus.documents.filter(doc => have.has(doc.sha256)).map(doc => doc.filename),
      });
    }
  }
  return { ok: reasons.length === 0, reasons, databaseName, workspaces: plans };
}

/** Vouches only for the exact bytes the manifest pins. This is an integrity gate for reviewed synthetic text, not an antivirus verdict. */
const manifestPinnedScanner = (pinnedSha256: string): MalwareScanner => ({
  engine: "manifest-pinned-synthetic",
  async scan(buffer) {
    return sha256Hex(buffer) === pinnedSha256 ? { status: "clean", engine: "manifest-pinned-synthetic" } : { status: "error", engine: "manifest-pinned-synthetic", detail: "bytes_differ_from_manifest" };
  },
});

export type ImportReport = {
  corpusId: string; databaseName: string;
  workspaces: Array<{ workspaceId: number; inserted: string[]; alreadyPresent: string[]; chunksWritten: number }>;
  totals: { inserted: number; alreadyPresent: number; chunksWritten: number };
};

export async function applyImport(input: { db: Db; corpus: LoadedCorpus; plan: ImportPlan; confirm: string; expectDatabase: string }): Promise<ImportReport> {
  const { db, corpus, plan } = input;
  if (!plan.ok) throw new ImportRefusal("plan is not ok; nothing written", plan.reasons);
  const actualDatabase = await currentDatabaseName(db);
  if (!input.expectDatabase || input.expectDatabase !== actualDatabase || actualDatabase !== plan.databaseName) {
    throw new ImportRefusal("--expect-database does not match the connected database; nothing written");
  }
  const expected = confirmationToken(corpus, plan.workspaces.map(w => w.workspaceId), actualDatabase);
  if (input.confirm !== expected) throw new ImportRefusal("confirmation token does not match this corpus, these workspaces and this database; nothing written");

  const report: ImportReport = { corpusId: corpus.corpusId, databaseName: actualDatabase, workspaces: [], totals: { inserted: 0, alreadyPresent: 0, chunksWritten: 0 } };
  for (const workspace of plan.workspaces) {
    const entry = { workspaceId: workspace.workspaceId, inserted: [] as string[], alreadyPresent: [] as string[], chunksWritten: 0 };
    for (const doc of corpus.documents) {
      const extracted = await extractDocument(doc.bytes, doc.mimeType, { filename: doc.filename, scanner: manifestPinnedScanner(doc.sha256) });
      if (!extracted.text || !extracted.segments.length) throw new ImportRefusal(`${doc.filename}: no extractable text`);
      // Serialised per workspace by a ROW lock that lives until COMMIT (an advisory lock released before commit would let a
      // concurrent run miss this run's insert). Both reads are locking "current" reads, so they see the latest committed rows
      // even under REPEATABLE READ.
      const outcome = await db.transaction(async tx => {
        const locked = await tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, workspace.workspaceId)).limit(1).for("update");
        if (!locked[0]) throw new ImportRefusal(`workspace ${workspace.workspaceId}: disappeared during import; nothing further written`);
        const existing = await tx.select({ id: documents.id }).from(documents).where(and(eq(documents.workspaceId, workspace.workspaceId), eq(documents.contentHash, doc.sha256))).limit(1).for("update");
        if (existing[0]) return { inserted: false, chunks: 0 };
        const [header] = await tx.insert(documents).values({
          workspaceId: workspace.workspaceId, projectId: null, filename: doc.filename, mimeType: doc.mimeType, storageKey: null,
          extractedText: extracted.text, contentHash: doc.sha256, pageCount: extracted.pageCount,
        });
        const documentId = Number((header as unknown as { insertId: number }).insertId);
        if (!Number.isInteger(documentId) || documentId <= 0) throw new Error("document insert returned no id");
        const chunks = extracted.segments.map((segment, chunkIndex) => ({
          ...segment, searchText: searchTextFor(segment.content), chunkIndex, documentId, workspaceId: workspace.workspaceId, embeddingJson: null, embeddingModel: null,
        }));
        await tx.insert(documentChunks).values(chunks);
        return { inserted: true, chunks: chunks.length };
      });
      if (outcome.inserted) { entry.inserted.push(doc.filename); entry.chunksWritten += outcome.chunks; } else entry.alreadyPresent.push(doc.filename);
    }
    report.workspaces.push(entry);
    report.totals.inserted += entry.inserted.length; report.totals.alreadyPresent += entry.alreadyPresent.length; report.totals.chunksWritten += entry.chunksWritten;
  }
  return report;
}

/** Read-only post-condition: every corpus document is present in the workspace with at least one chunk, all scoped to that workspace. */
export async function verifyImport(db: Db, corpus: LoadedCorpus, workspaceId: number): Promise<{ ok: boolean; missing: string[]; withoutChunks: string[] }> {
  const missing: string[] = []; const withoutChunks: string[] = [];
  for (const doc of corpus.documents) {
    const rows = await db.select({ id: documents.id }).from(documents).where(and(eq(documents.workspaceId, workspaceId), eq(documents.contentHash, doc.sha256))).limit(1);
    if (!rows[0]) { missing.push(doc.filename); continue; }
    const [counted] = (await db.execute(sql`SELECT COUNT(*) AS n FROM documentChunks WHERE documentId = ${rows[0].id} AND workspaceId = ${workspaceId}`)) as unknown as [Array<{ n: number | string }>];
    if (Number(counted[0]?.n) < 1) withoutChunks.push(doc.filename);
  }
  return { ok: !missing.length && !withoutChunks.length, missing, withoutChunks };
}
