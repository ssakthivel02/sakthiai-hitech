import { TRPCError } from "@trpc/server";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../db";
import { adminProcedure, router } from "../_core/trpc";
import { readCreatorPaidAllowlists, readCreatorPaidConfig } from "./paidPolicy";
import { getCreatorSpendLedger, type CreatorSpendDbProvider } from "./spendLedger";
import { reconcileCreatorSpend, resolveCreatorSpendHold } from "./spendReconciler";

/**
 * Administrator spend visibility for Creator paid generation (UTC day). Read-only except `reconcile` (apply=true)
 * and `resolveHold`, which settle reservations through the guarded ledger and record who did it.
 * Never returns credentials, prompts or provider payloads; allowlists are reported as counts.
 */
const rowsOf = <T>(result: unknown): T[] => (Array.isArray(result) ? (Array.isArray(result[0]) ? (result[0] as T[]) : (result as T[])) : []);
const num = (value: unknown) => Number(value ?? 0);

export async function creatorSpendSummary(getDbProvider: CreatorSpendDbProvider, staleAfterMinutes = 60, env: Record<string, string | undefined> = process.env) {
  const db = await getDbProvider();
  if (!db) throw new Error("CREATOR_SPEND_LEDGER_UNAVAILABLE");
  const config = readCreatorPaidConfig(env);
  const allowlists = readCreatorPaidAllowlists(env);
  const day = new Date().toISOString().slice(0, 10);
  const windowsFor = async (pattern: string) => rowsOf<{ scope: string; generations: unknown; cost: unknown }>(
    await db.execute(sql`SELECT scope, generations, cost FROM creatorSpendWindows WHERE windowStart = ${day} AND scope LIKE ${pattern} ORDER BY cost DESC, generations DESC LIMIT 20`),
  );
  const windows = [...(await windowsFor("global")), ...(await windowsFor("workspace:%")), ...(await windowsFor("user:%"))];
  const states = rowsOf<{ state: string; holds: unknown; cost: unknown }>(
    await db.execute(sql`SELECT state, COUNT(*) AS holds, COALESCE(SUM(cost), 0) AS cost FROM creatorSpendHolds WHERE windowStart = ${day} GROUP BY state`),
  );
  const [stale] = rowsOf<{ holds: unknown; cost: unknown }>(
    await db.execute(sql`SELECT COUNT(*) AS holds, COALESCE(SUM(cost), 0) AS cost FROM creatorSpendHolds
      WHERE state = 'HELD' AND createdAt < (CURRENT_TIMESTAMP - INTERVAL ${Math.max(1, Math.floor(staleAfterMinutes))} MINUTE)`),
  );
  const recent = rowsOf<Record<string, unknown>>(
    await db.execute(sql`SELECT id, workspaceId, userId, generationId, kind, model, cost, state, createdAt, settledAt, settledBy, settlementNote
      FROM creatorSpendHolds ORDER BY createdAt DESC LIMIT 50`),
  );
  const global = windows.find(w => w.scope === "global");
  const scoped = (prefix: string) => windows.filter(w => w.scope.startsWith(prefix)).slice(0, 20).map(w => ({ id: Number(w.scope.slice(prefix.length)), generations: num(w.generations), cost: num(w.cost) }));
  return {
    day,
    policy: config.ok
      ? { enabled: true, valid: true, limits: config.config.limits, pricedModels: [...config.config.costs.keys()] }
      : { enabled: config.code !== "CREATOR_PAID_GENERATION_DISABLED", valid: false, reason: config.code === "CREATOR_SPEND_POLICY_INVALID" ? config.detail : config.code },
    allowlistedUsers: { image: allowlists.imageUsers.size, video: allowlists.videoUsers.size },
    global: { generations: num(global?.generations), cost: num(global?.cost) },
    topWorkspaces: scoped("workspace:"),
    topUsers: scoped("user:"),
    holdsToday: Object.fromEntries(states.map(s => [s.state, { holds: num(s.holds), cost: num(s.cost) }])),
    staleHeld: { holds: num(stale?.holds), cost: num(stale?.cost), olderThanMinutes: staleAfterMinutes },
    recentHolds: recent.map(r => ({
      id: String(r.id), workspaceId: num(r.workspaceId), userId: num(r.userId), generationId: r.generationId === null ? null : num(r.generationId),
      kind: String(r.kind), model: String(r.model), cost: num(r.cost), state: String(r.state),
      createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
      settledAt: r.settledAt ? (r.settledAt instanceof Date ? r.settledAt.toISOString() : String(r.settledAt)) : null,
      settledBy: r.settledBy ? String(r.settledBy) : null, settlementNote: r.settlementNote ? String(r.settlementNote) : null,
    })),
  };
}

function ledgerError(error: unknown): never {
  const message = error instanceof Error ? error.message : "CREATOR_SPEND_ERROR";
  if (message.startsWith("CREATOR_RESOLUTION") || message === "CREATOR_RECONCILE_WINDOW_TOO_SHORT") throw new TRPCError({ code: "BAD_REQUEST", message });
  if (message === "CREATOR_SPEND_HOLD_NOT_FOUND") throw new TRPCError({ code: "NOT_FOUND", message });
  throw new TRPCError({ code: "PRECONDITION_FAILED", message: "CREATOR_SPEND_LEDGER_UNAVAILABLE" });
}

const staleInput = z.object({ staleAfterMinutes: z.number().int().min(15).max(7 * 24 * 60).default(60) });

export const creatorSpendAdminRouter = router({
  summary: adminProcedure.input(staleInput.optional()).query(async ({ input }) => {
    try {
      return await creatorSpendSummary(getDb, input?.staleAfterMinutes ?? 60);
    } catch (error) {
      ledgerError(error);
    }
  }),
  reconcile: adminProcedure.input(staleInput.extend({ apply: z.boolean().default(false) })).mutation(async ({ input }) => {
    try {
      return await reconcileCreatorSpend({ getDb, ledger: getCreatorSpendLedger(), apply: input.apply, staleAfterMinutes: input.staleAfterMinutes });
    } catch (error) {
      ledgerError(error);
    }
  }),
  resolveHold: adminProcedure
    .input(z.object({ holdId: z.string().min(1).max(96), outcome: z.enum(["charged", "not_charged"]), note: z.string().trim().min(8).max(200) }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await resolveCreatorSpendHold({ getDb, ledger: getCreatorSpendLedger(), holdId: input.holdId, outcome: input.outcome, adminUserId: ctx.user.id, note: input.note });
      } catch (error) {
        ledgerError(error);
      }
    }),
});
