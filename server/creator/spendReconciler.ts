import { sql } from "drizzle-orm";
import type { CreatorSettlement, CreatorSpendDbProvider, CreatorSpendLedger } from "./spendLedger";

/**
 * Creator spend reconciliation for reservations left HELD (instance crash, settlement write failure, ambiguous
 * provider outcome). Conservative by construction:
 *
 *  - COMMIT  only when the provider provably accepted the job (a provider job row exists, or the generation reached a
 *            state that only a provider acceptance produces).
 *  - RELEASE only when the provider provably never received the job:
 *              QUEUED          -> the request died before `beginProviderSubmission`; the generation is first closed with a
 *                                 guarded QUEUED -> FAILED update, so a slow in-flight request can no longer submit it;
 *              FAILED / CANCELLED with a definitive (non-ambiguous) failure class and no provider job.
 *  - MANUAL  everything that cannot be proven (SUBMISSION_UNKNOWN, ambiguous failures, missing generation): stays HELD
 *            and counted until an administrator records a decision (`resolveCreatorSpendHold`).
 *
 * Dry-run by default. Each apply is idempotent (ledger settlement is guarded by state = 'HELD').
 */
export type ReconcileAction = "COMMIT" | "RELEASE" | "MANUAL";

export type StaleHoldRow = {
  holdId: string;
  workspaceId: number;
  userId: number;
  kind: string;
  model: string;
  cost: number;
  ageMinutes: number;
  generationId: number | null;
  generationStatus: string | null;
  failureClass: string | null;
  providerJobs: number;
};

export type ReconcileItem = StaleHoldRow & { action: ReconcileAction; reason: string; applied: boolean };

export type ReconcileReport = {
  dryRun: boolean;
  staleAfterMinutes: number;
  scanned: number;
  commit: number;
  release: number;
  manual: number;
  applied: { commit: number; release: number };
  items: ReconcileItem[];
};

const AMBIGUOUS = new Set(["NETWORK", "TIMEOUT", "PROVIDER_UNAVAILABLE", "UNKNOWN"]);
const PROVIDER_ACCEPTED = new Set(["SUBMITTED", "RUNNING", "SUCCEEDED", "RETRYABLE"]);
export const RESERVATION_EXPIRED = "CREATOR_RESERVATION_EXPIRED_BEFORE_SUBMISSION";

export function classifyStaleHold(row: Pick<StaleHoldRow, "generationId" | "generationStatus" | "failureClass" | "providerJobs">): { action: ReconcileAction; reason: string } {
  if (row.generationId === null || row.generationStatus === null) return { action: "MANUAL", reason: "generation_missing" };
  if (row.providerJobs > 0) return { action: "COMMIT", reason: "provider_job_exists" };
  if (PROVIDER_ACCEPTED.has(row.generationStatus)) return { action: "COMMIT", reason: `generation_${row.generationStatus.toLowerCase()}` };
  if (row.generationStatus === "QUEUED") return { action: "RELEASE", reason: "never_submitted" };
  if (row.generationStatus === "SUBMISSION_UNKNOWN") return { action: "MANUAL", reason: "submission_unknown" };
  if (row.generationStatus === "FAILED" || row.generationStatus === "CANCELLED") {
    if (!row.failureClass && row.generationStatus === "CANCELLED") return { action: "RELEASE", reason: "cancelled_before_provider" };
    if (row.failureClass && !AMBIGUOUS.has(row.failureClass)) return { action: "RELEASE", reason: `definitive_failure_${row.failureClass.toLowerCase()}` };
    return { action: "MANUAL", reason: `ambiguous_failure_${(row.failureClass ?? "none").toLowerCase()}` };
  }
  return { action: "MANUAL", reason: `unexpected_status_${row.generationStatus.toLowerCase()}` };
}

const rowsOf = <T>(result: unknown): T[] => (Array.isArray(result) ? (Array.isArray(result[0]) ? (result[0] as T[]) : (result as T[])) : []);
const affected = (result: unknown): number => Number((Array.isArray(result) ? (result[0] as { affectedRows?: number }) : (result as { affectedRows?: number }))?.affectedRows ?? 0);

export async function listStaleCreatorHolds(getDb: CreatorSpendDbProvider, staleAfterMinutes: number, limit = 500): Promise<StaleHoldRow[]> {
  const db = await getDb();
  if (!db) throw new Error("CREATOR_SPEND_LEDGER_UNAVAILABLE");
  const rows = rowsOf<Record<string, unknown>>(await db.execute(sql`
    SELECT h.id AS holdId, h.workspaceId, h.userId, h.kind, h.model, h.cost,
           TIMESTAMPDIFF(MINUTE, h.createdAt, CURRENT_TIMESTAMP) AS ageMinutes,
           g.id AS generationId, g.status AS generationStatus, g.failureClass,
           (SELECT COUNT(*) FROM creatorProviderJobs j WHERE j.generationId = g.id AND j.workspaceId = h.workspaceId) AS providerJobs
      FROM creatorSpendHolds h
      LEFT JOIN creatorGenerations g
        ON g.workspaceId = h.workspaceId
       AND (g.id = h.generationId OR (h.generationId IS NULL AND CONCAT('ws:', g.workspaceId, ':', g.idempotencyKey) = h.id))
     WHERE h.state = 'HELD' AND h.createdAt < (CURRENT_TIMESTAMP - INTERVAL ${Math.max(1, Math.floor(staleAfterMinutes))} MINUTE)
     ORDER BY h.createdAt
     LIMIT ${Math.max(1, Math.min(5000, Math.floor(limit)))}`));
  return rows.map(r => ({
    holdId: String(r.holdId),
    workspaceId: Number(r.workspaceId),
    userId: Number(r.userId),
    kind: String(r.kind),
    model: String(r.model),
    cost: Number(r.cost),
    ageMinutes: Number(r.ageMinutes),
    generationId: r.generationId === null || r.generationId === undefined ? null : Number(r.generationId),
    generationStatus: r.generationStatus === null || r.generationStatus === undefined ? null : String(r.generationStatus),
    failureClass: r.failureClass === null || r.failureClass === undefined ? null : String(r.failureClass),
    providerJobs: Number(r.providerJobs ?? 0),
  }));
}

export async function reconcileCreatorSpend(input: {
  getDb: CreatorSpendDbProvider;
  ledger: CreatorSpendLedger;
  apply: boolean;
  staleAfterMinutes?: number;
  limit?: number;
}): Promise<ReconcileReport> {
  const staleAfterMinutes = input.staleAfterMinutes ?? 60;
  if (!Number.isFinite(staleAfterMinutes) || staleAfterMinutes < 15) throw new Error("CREATOR_RECONCILE_WINDOW_TOO_SHORT"); // never race live requests
  const rows = await listStaleCreatorHolds(input.getDb, staleAfterMinutes, input.limit);
  const settlement = (reason: string): CreatorSettlement => ({ by: "reconciler", note: reason });
  const items: ReconcileItem[] = [];
  const applied = { commit: 0, release: 0 };
  for (const row of rows) {
    const { action, reason } = classifyStaleHold(row);
    let done = false;
    if (input.apply && action === "COMMIT" && row.generationId !== null) {
      done = await input.ledger.commit(row.holdId, row.generationId, settlement(reason));
      if (done) applied.commit++;
    } else if (input.apply && action === "RELEASE" && row.generationId !== null) {
      let closed = true;
      if (row.generationStatus === "QUEUED") {
        // Close the never-submitted generation first; an in-flight request then fails its own QUEUED-guarded transition.
        const db = await input.getDb();
        if (!db) throw new Error("CREATOR_SPEND_LEDGER_UNAVAILABLE");
        closed = affected(await db.execute(sql`UPDATE creatorGenerations SET status = 'FAILED', failureClass = 'QUOTA', errorMessage = ${RESERVATION_EXPIRED}, completedAt = CURRENT_TIMESTAMP
          WHERE id = ${row.generationId} AND workspaceId = ${row.workspaceId} AND status = 'QUEUED'`)) === 1;
      }
      if (closed) {
        done = await input.ledger.release(row.holdId, settlement(reason));
        if (done) applied.release++;
      }
    }
    items.push({ ...row, action, reason, applied: done });
  }
  return {
    dryRun: !input.apply,
    staleAfterMinutes,
    scanned: rows.length,
    commit: items.filter(i => i.action === "COMMIT").length,
    release: items.filter(i => i.action === "RELEASE").length,
    manual: items.filter(i => i.action === "MANUAL").length,
    applied,
    items,
  };
}

/**
 * Administrator decision for a hold the reconciler cannot prove (e.g. SUBMISSION_UNKNOWN after checking the provider
 * console). `charged` commits, `not_charged` releases. A note is mandatory; the decision is recorded on the hold.
 */
export async function resolveCreatorSpendHold(input: {
  getDb: CreatorSpendDbProvider;
  ledger: CreatorSpendLedger;
  holdId: string;
  outcome: "charged" | "not_charged";
  adminUserId: number;
  note: string;
}): Promise<{ applied: boolean; state: string }> {
  const note = input.note.trim();
  if (note.length < 8) throw new Error("CREATOR_RESOLUTION_NOTE_REQUIRED");
  const db = await input.getDb();
  if (!db) throw new Error("CREATOR_SPEND_LEDGER_UNAVAILABLE");
  const [hold] = rowsOf<{ state: string }>(await db.execute(sql`SELECT state FROM creatorSpendHolds WHERE id = ${input.holdId}`));
  if (!hold) throw new Error("CREATOR_SPEND_HOLD_NOT_FOUND");
  if (hold.state !== "HELD") return { applied: false, state: hold.state };
  const settlement: CreatorSettlement = { by: `admin:${input.adminUserId}`, note: `${input.outcome}: ${note}` };
  const applied = input.outcome === "charged"
    ? await input.ledger.commit(input.holdId, null, settlement)
    : await input.ledger.release(input.holdId, settlement);
  const [after] = rowsOf<{ state: string }>(await db.execute(sql`SELECT state FROM creatorSpendHolds WHERE id = ${input.holdId}`));
  return { applied, state: after?.state ?? "UNKNOWN" };
}
