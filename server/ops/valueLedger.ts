import { TRPCError } from "@trpc/server";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../db";
import { adminProcedure, router } from "../_core/trpc";

/**
 * Value Ledger v1: one administrator view of what the platform did and what it cost, per UTC day.
 *
 * Read-only aggregation over tables that already exist (no migration):
 * - model:    providerUsageWindows (actual requests/tokens/cost after commit) and providerUsageHolds (per-provider outcome)
 * - creator:  creatorSpendWindows (scope "global") and creatorSpendHolds (per-model outcome)
 * - activity: messages, conversations, documents and projects created per day
 *
 * Truthfulness rules:
 * - Model usage is persisted only with GATEWAY_STATE_STORE=mysql. Otherwise the model section says "not_persisted"
 *   instead of reporting zeros that look like "no usage".
 * - Model and Creator costs are in different, separately configured units and are never added together.
 * - Output quality is not measured here: no user-feedback signal exists. `quality` says so.
 * - Aggregates only: no prompts, messages, file names, identities or provider payloads leave the database.
 */
const rowsOf = <T>(result: unknown): T[] => (Array.isArray(result) ? (Array.isArray(result[0]) ? (result[0] as T[]) : (result as T[])) : []);
const num = (value: unknown) => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const dayOf = (value: unknown) => (value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10));
const round = (n: number) => Math.round(n * 1e6) / 1e6;

export const MAX_LEDGER_DAYS = 31;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export type ValueLedgerRange = { from: string; to: string };

/** Inclusive UTC-day range, at most MAX_LEDGER_DAYS, from <= to, real calendar days. */
export function normalizeRange(range: ValueLedgerRange): { from: string; to: string; days: string[] } {
  if (!DAY.test(range.from) || !DAY.test(range.to)) throw new Error("VALUE_LEDGER_RANGE_INVALID");
  const start = Date.parse(`${range.from}T00:00:00Z`);
  const end = Date.parse(`${range.to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || new Date(start).toISOString().slice(0, 10) !== range.from || new Date(end).toISOString().slice(0, 10) !== range.to) throw new Error("VALUE_LEDGER_RANGE_INVALID");
  if (end < start) throw new Error("VALUE_LEDGER_RANGE_INVALID");
  const count = Math.round((end - start) / 86_400_000) + 1;
  if (count > MAX_LEDGER_DAYS) throw new Error("VALUE_LEDGER_RANGE_TOO_LONG");
  return { from: range.from, to: range.to, days: Array.from({ length: count }, (_, i) => new Date(start + i * 86_400_000).toISOString().slice(0, 10)) };
}

type Outcome = { committed: number; released: number; held: number };
const outcomeOf = (rows: Array<{ state: unknown; n: unknown }>): Outcome => {
  const o: Outcome = { committed: 0, released: 0, held: 0 };
  for (const r of rows) {
    const s = String(r.state);
    if (s === "COMMITTED") o.committed += num(r.n);
    else if (s === "RELEASED") o.released += num(r.n);
    else if (s === "HELD") o.held += num(r.n);
  }
  return o;
};
/** Share of settled calls that were released (failed, refused after reservation or cancelled). null when nothing settled. */
const releasedShare = (o: Outcome) => (o.committed + o.released > 0 ? round(o.released / (o.committed + o.released)) : null);

export type ValueLedgerDb = { execute: (query: ReturnType<typeof sql>) => Promise<unknown> };

export async function buildValueLedger(db: ValueLedgerDb, range: ValueLedgerRange, env: Record<string, string | undefined> = process.env) {
  const { from, to, days } = normalizeRange(range);
  // Activity tables use TIMESTAMP columns: bound and bucket them by epoch so the UTC day is independent of the session
  // time zone (FROM_UNIXTIME and the column are both rendered in the session zone; UNIX_TIMESTAMP is zone-free).
  const fromEpoch = Date.parse(`${from}T00:00:00Z`) / 1000;
  const toEpoch = Date.parse(`${to}T00:00:00Z`) / 1000 + 86_400;
  const modelPersisted = env.GATEWAY_STATE_STORE?.trim().toLowerCase() === "mysql";
  const modelUnit = env.GATEWAY_COST_UNIT?.trim() || null;

  const q = async <T>(query: ReturnType<typeof sql>) => rowsOf<T>(await db.execute(query));

  const [modelDays, modelProviders, creatorDays, creatorModels, activity] = await Promise.all([
    q<{ d: unknown; requests: unknown; tokens: unknown; cost: unknown; estimated: unknown }>(sql`SELECT windowStart AS d, SUM(requests) AS requests, SUM(tokens) AS tokens, SUM(cost) AS cost, SUM(estimatedCommits) AS estimated
      FROM providerUsageWindows WHERE windowStart BETWEEN ${from} AND ${to} GROUP BY windowStart`),
    q<{ providerId: unknown; state: unknown; n: unknown }>(sql`SELECT providerId, state, COUNT(*) AS n FROM providerUsageHolds WHERE windowStart BETWEEN ${from} AND ${to} GROUP BY providerId, state`),
    q<{ d: unknown; generations: unknown; cost: unknown }>(sql`SELECT windowStart AS d, generations, cost FROM creatorSpendWindows WHERE scope = 'global' AND windowStart BETWEEN ${from} AND ${to}`),
    q<{ model: unknown; kind: unknown; state: unknown; n: unknown; cost: unknown }>(sql`SELECT model, kind, state, COUNT(*) AS n, COALESCE(SUM(cost), 0) AS cost FROM creatorSpendHolds WHERE windowStart BETWEEN ${from} AND ${to} GROUP BY model, kind, state`),
    Promise.all([
      q<{ dn: unknown; role: unknown; n: unknown }>(sql`SELECT FLOOR(UNIX_TIMESTAMP(createdAt) / 86400) AS dn, role, COUNT(*) AS n FROM messages WHERE createdAt >= FROM_UNIXTIME(${fromEpoch}) AND createdAt < FROM_UNIXTIME(${toEpoch}) GROUP BY dn, role`),
      q<{ dn: unknown; n: unknown }>(sql`SELECT FLOOR(UNIX_TIMESTAMP(createdAt) / 86400) AS dn, COUNT(*) AS n FROM conversations WHERE createdAt >= FROM_UNIXTIME(${fromEpoch}) AND createdAt < FROM_UNIXTIME(${toEpoch}) GROUP BY dn`),
      q<{ dn: unknown; n: unknown }>(sql`SELECT FLOOR(UNIX_TIMESTAMP(createdAt) / 86400) AS dn, COUNT(*) AS n FROM documents WHERE createdAt >= FROM_UNIXTIME(${fromEpoch}) AND createdAt < FROM_UNIXTIME(${toEpoch}) GROUP BY dn`),
      q<{ dn: unknown; n: unknown }>(sql`SELECT FLOOR(UNIX_TIMESTAMP(createdAt) / 86400) AS dn, COUNT(*) AS n FROM projects WHERE createdAt >= FROM_UNIXTIME(${fromEpoch}) AND createdAt < FROM_UNIXTIME(${toEpoch}) GROUP BY dn`),
    ]),
  ]);
  const [messageRows, conversationRows, documentRows, projectRows] = activity;

  const byDay = <T extends { d: unknown }>(rows: T[]) => new Map(rows.map(r => [dayOf(r.d), r] as const));
  const epochDay = (dn: unknown) => new Date(num(dn) * 86_400_000).toISOString().slice(0, 10);
  const countByDay = (rows: Array<{ dn: unknown; n: unknown }>) => new Map(rows.map(r => [epochDay(r.dn), num(r.n)] as const));
  const md = byDay(modelDays);
  const cd = byDay(creatorDays);
  const conv = countByDay(conversationRows);
  const docs = countByDay(documentRows);
  const proj = countByDay(projectRows);
  const msg = new Map<string, { user: number; assistant: number }>();
  for (const r of messageRows) {
    const k = epochDay(r.dn);
    const m = msg.get(k) ?? { user: 0, assistant: 0 };
    if (r.role === "user") m.user += num(r.n);
    if (r.role === "assistant") m.assistant += num(r.n);
    msg.set(k, m);
  }

  const daily = days.map(day => {
    const m = md.get(day);
    const c = cd.get(day);
    const messages = msg.get(day) ?? { user: 0, assistant: 0 };
    return {
      day,
      model: modelPersisted ? { requests: num(m?.requests), tokens: num(m?.tokens), cost: round(num(m?.cost)), estimatedCommits: num(m?.estimated) } : null,
      creator: { generations: num(c?.generations), cost: round(num(c?.cost)) },
      activity: { userMessages: messages.user, assistantMessages: messages.assistant, conversations: conv.get(day) ?? 0, documents: docs.get(day) ?? 0, projects: proj.get(day) ?? 0 },
    };
  });

  const sum = (pick: (d: (typeof daily)[number]) => number) => daily.reduce((a, d) => a + pick(d), 0);
  const modelTotals = modelPersisted
    ? { requests: sum(d => d.model!.requests), tokens: sum(d => d.model!.tokens), cost: round(sum(d => d.model!.cost)), estimatedCommits: sum(d => d.model!.estimatedCommits) }
    : null;
  const assistantMessages = sum(d => d.activity.assistantMessages);

  const providers = new Map<string, Array<{ state: unknown; n: unknown }>>();
  for (const r of modelProviders) providers.set(String(r.providerId), [...(providers.get(String(r.providerId)) ?? []), r]);
  const creatorByModel = new Map<string, { kind: string; rows: Array<{ state: unknown; n: unknown }>; committedCost: number }>();
  for (const r of creatorModels) {
    const key = String(r.model);
    const e = creatorByModel.get(key) ?? { kind: String(r.kind), rows: [], committedCost: 0 };
    e.rows.push(r);
    if (String(r.state) === "COMMITTED") e.committedCost += num(r.cost);
    creatorByModel.set(key, e);
  }

  return {
    schema: "sakthiai.value-ledger/v1",
    range: { from, to, days: days.length, timezone: "UTC" },
    model: {
      usageRecording: modelPersisted ? ("persisted" as const) : ("not_persisted" as const),
      note: modelPersisted ? "Actual tokens and cost after commit; estimatedCommits counts calls whose usage the provider did not report." : "GATEWAY_STATE_STORE is not mysql: model usage is kept per process and is not in the database, so it is not reported here.",
      costUnit: modelUnit,
      totals: modelTotals,
      costPerAssistantMessage: modelTotals && modelUnit && assistantMessages > 0 ? round(modelTotals.cost / assistantMessages) : null,
      providers: [...providers.entries()].map(([providerId, rows]) => {
        const o = outcomeOf(rows);
        return { providerId, ...o, releasedShare: releasedShare(o) };
      }),
    },
    creator: {
      costUnit: "as configured for Creator paid models (separate from the model cost unit; never added to it)",
      totals: { generations: sum(d => d.creator.generations), cost: round(sum(d => d.creator.cost)) },
      models: [...creatorByModel.entries()].map(([model, e]) => {
        const o = outcomeOf(e.rows);
        return { model, kind: e.kind, ...o, committedCost: round(e.committedCost), releasedShare: releasedShare(o) };
      }),
    },
    activity: {
      totals: { userMessages: sum(d => d.activity.userMessages), assistantMessages, conversations: sum(d => d.activity.conversations), documents: sum(d => d.activity.documents), projects: sum(d => d.activity.projects) },
    },
    quality: { status: "NOT_MEASURED" as const, note: "No user feedback or graded evaluation is recorded per answer. Model quality evidence comes from the separate Q8 evaluation, not from this ledger." },
    daily,
  };
}

const rangeInput = z.object({ from: z.string().regex(DAY), to: z.string().regex(DAY) });

export const opsRouter = router({
  valueLedger: adminProcedure.input(rangeInput).query(async ({ input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "VALUE_LEDGER_DATABASE_UNAVAILABLE" });
    try {
      return await buildValueLedger(db as unknown as ValueLedgerDb, input);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message.startsWith("VALUE_LEDGER_RANGE")) throw new TRPCError({ code: "BAD_REQUEST", message });
      console.error("value ledger failed", message.slice(0, 200));
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "VALUE_LEDGER_UNAVAILABLE" });
    }
  }),
});
