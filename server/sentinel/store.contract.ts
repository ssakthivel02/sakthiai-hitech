import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { TraceBuilder } from "./engine/trace";
import { SentinelConflictError } from "./store";
import type { SentinelStore } from "./store";
import type { StoredEvent } from "./types";
import { newRow, OTHER_WS, WS } from "./testkit";
import type { FinalSummary } from "./replay";

/**
 * Behavioural contract every SentinelStore must satisfy. Run against InMemorySentinelStore (always) and MysqlSentinelStore
 * (store.mysql.test.ts, throwaway local database only).
 */
export function defineStoreContract(label: string, make: () => Promise<{ store: SentinelStore; cleanup?: () => Promise<void> }>, opts: { skip?: boolean } = {}) {
  const d = opts.skip ? describe.skip : describe;
  d(`SentinelStore contract: ${label}`, () => {
    const chain = (id: string, n: number): StoredEvent[] => {
      const b = new TraceBuilder(id);
      for (let i = 0; i < n; i++) b.add(i === 0 ? "run_start" : "step", i, { i });
      return b.events.map((e) => ({ seq: e.seq, type: e.type, vt: e.vt, payload: e.payload, prev: e.prev, hash: e.hash }));
    };
    const fresh = async (over: Parameters<typeof newRow>[0] = {}) => { const ctx = await make(); const id = over.id ?? randomUUID(); const rec = await ctx.store.create(newRow({ ...over, id })); return { ...ctx, id, rec }; };
    const summaryFor = (events: StoredEvent[], over: Partial<FinalSummary> = {}): FinalSummary => ({
      status: "COMPLETED", stopReason: "FINAL", outcome: "DIAGNOSIS", label: "DISK_FULL", confidence: 0.8, verified: true,
      traceHead: events.length ? events[events.length - 1]!.hash : null, eventCount: events.length, errorMessage: null, ...over,
    });

    it("creates idempotently, scopes every read to the workspace, and never reveals a foreign id", async () => {
      const { store, id, rec, cleanup } = await fresh();
      try {
        expect(rec).toMatchObject({ id, workspaceId: WS, status: "QUEUED", eventCount: 0, taskId: null, title: "Disk alarm on db-1" });
        expect(rec.limits.max_tool_calls).toBeGreaterThan(0); expect(rec.inventory.hosts).toEqual(["db-1"]);
        const again = await store.create(newRow({ id, title: "different title must not overwrite" }));
        expect(again.title).toBe("Disk alarm on db-1");                        // idempotent: stored row returned unchanged
        await expect(store.create(newRow({ id, workspaceId: OTHER_WS }))).rejects.toBeInstanceOf(SentinelConflictError);
        expect(await store.get(OTHER_WS, id)).toBeNull();
        expect(await store.readEvents(OTHER_WS, id)).toEqual([]);
        await expect(store.appendEvents(OTHER_WS, id, chain(id, 2))).rejects.toThrow(/not found/);
        expect(await store.markCancelled(OTHER_WS, id)).toBe(false);
        expect((await store.listPage(OTHER_WS)).items).toEqual([]);
        expect((await store.get(WS, id))!.status).toBe("QUEUED");
      } finally { await cleanup?.(); }
    });

    it("binds a task exactly once", async () => {
      const { store, id, cleanup } = await fresh();
      try {
        const t1 = randomUUID(), t2 = randomUUID();
        expect(await store.attachTask(WS, id, t1)).toBe(true);
        expect(await store.attachTask(WS, id, t1)).toBe(true);                  // same task: no-op
        expect(await store.attachTask(WS, id, t2)).toBe(false);                 // different task: refused, nothing changed
        expect(await store.attachTask(OTHER_WS, id, t2)).toBe(false);
        expect((await store.get(WS, id))!.taskId).toBe(t1);
      } finally { await cleanup?.(); }
    });

    it("appends a hash chain idempotently and rejects forks, gaps and broken links; row summary mirrors the stored trace", async () => {
      const { store, id, cleanup } = await fresh();
      try {
        const all = chain(id, 6);
        await store.appendEvents(WS, id, all.slice(0, 3));
        await store.appendEvents(WS, id, all.slice(0, 3));                       // replay of the same batch
        await store.appendEvents(WS, id, all.slice(2, 6));                       // overlap + extension
        const got = await store.readEvents(WS, id);
        expect(got.map((e) => e.hash)).toEqual(all.map((e) => e.hash));
        expect(got[3]!.payload).toEqual({ i: 3 });
        const row = (await store.get(WS, id))!;
        expect(row.eventCount).toBe(6); expect(row.traceHead).toBe(all[5]!.hash);
        expect((await store.readEvents(WS, id, { fromSeq: 4 })).map((e) => e.seq)).toEqual([4, 5]);
        expect((await store.readEvents(WS, id, { limit: 2 })).map((e) => e.seq)).toEqual([0, 1]);
        const fork = chain(id, 6).map((e, i) => (i === 4 ? { ...e, hash: "f".repeat(64) } : e));
        await expect(store.appendEvents(WS, id, [fork[4]!])).rejects.toBeInstanceOf(SentinelConflictError);
        await expect(store.appendEvents(WS, id, chain(id, 9).slice(8))).rejects.toBeInstanceOf(SentinelConflictError);   // gap
        const extra = chain(id, 7)[6]!;
        await expect(store.appendEvents(WS, id, [{ ...extra, prev: "0".repeat(64) }])).rejects.toBeInstanceOf(SentinelConflictError);
        expect((await store.get(WS, id))!.eventCount).toBe(6);                  // rejected writes changed nothing
      } finally { await cleanup?.(); }
    });

    it("two concurrent writers with conflicting events cannot both succeed (no silent fork)", async () => {
      const { store, id, cleanup } = await fresh();
      try {
        const base = chain(id, 3);
        await store.appendEvents(WS, id, base);
        const b = new TraceBuilder(id); for (const e of base) b.events.push({ ...e }); (b as unknown as { prev: string }).prev = base[2]!.hash;
        const x = b.add("step", 3, { writer: "x" });
        const y = (() => { const c = new TraceBuilder(id); for (const e of base) c.events.push({ ...e }); (c as unknown as { prev: string }).prev = base[2]!.hash; return c.add("step", 3, { writer: "y" }); })();
        const wrap = (e: typeof x): StoredEvent => ({ seq: e.seq, type: e.type, vt: e.vt, payload: e.payload, prev: e.prev, hash: e.hash });
        const results = await Promise.allSettled([store.appendEvents(WS, id, [wrap(x)]), store.appendEvents(WS, id, [wrap(y)])]);
        expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
        const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
        expect(rejected.reason).toBeInstanceOf(SentinelConflictError);
        const got = await store.readEvents(WS, id);
        expect(got).toHaveLength(4);
        expect((await store.get(WS, id))!.traceHead).toBe(got[3]!.hash);
      } finally { await cleanup?.(); }
    });

    it("tracks state transitions: running once, finalize is guarded by the stored trace and terminal states are final", async () => {
      const { store, id, cleanup } = await fresh();
      try {
        await store.markRunning(WS, id); await store.markRunning(WS, id);
        const r1 = (await store.get(WS, id))!; expect(r1.status).toBe("RUNNING"); expect(r1.startedAt).toBeInstanceOf(Date);
        const ev = chain(id, 4);
        await store.appendEvents(WS, id, ev);
        await expect(store.finalize(WS, id, summaryFor(ev, { eventCount: 3 }))).rejects.toBeInstanceOf(SentinelConflictError);
        await expect(store.finalize(WS, id, summaryFor(ev, { traceHead: "a".repeat(64) }))).rejects.toBeInstanceOf(SentinelConflictError);
        expect((await store.get(WS, id))!.status).toBe("RUNNING");
        await store.finalize(OTHER_WS, id, summaryFor(ev));                      // foreign workspace: no-op
        expect((await store.get(WS, id))!.status).toBe("RUNNING");
        await store.finalize(WS, id, summaryFor(ev));
        const done = (await store.get(WS, id))!;
        expect(done).toMatchObject({ status: "COMPLETED", outcome: "DIAGNOSIS", label: "DISK_FULL", verified: true, eventCount: 4, traceHead: ev[3]!.hash, stopReason: "FINAL" });
        expect(done.confidence).toBeCloseTo(0.8); expect(done.finishedAt).toBeInstanceOf(Date);
        await store.finalize(WS, id, summaryFor(ev, { status: "FAILED", outcome: null, label: null }));   // terminal is final
        expect((await store.get(WS, id))!.status).toBe("COMPLETED");
        expect(await store.markCancelled(WS, id)).toBe(false);
        await store.markRunning(WS, id); expect((await store.get(WS, id))!.status).toBe("COMPLETED");
      } finally { await cleanup?.(); }
    });

    it("cancels queued/running rows, and finalises an enqueue failure with no events", async () => {
      const { store, id, cleanup } = await fresh();
      try {
        expect(await store.markCancelled(WS, id)).toBe(true);
        expect(await store.markCancelled(WS, id)).toBe(false);
        expect(await (async () => { const g = (await store.get(WS, id))!; return [g.status, g.stopReason, g.finishedAt instanceof Date]; })()).toEqual(["CANCELLED", "CANCELLED_BEFORE_START", true]);
        const id2 = randomUUID(); await store.create(newRow({ id: id2 }));
        await store.finalize(WS, id2, summaryFor([], { status: "FAILED", stopReason: "ENQUEUE_FAILED", outcome: null, label: null, confidence: null, verified: false, errorMessage: "could not enqueue" }));
        expect(await store.get(WS, id2)).toMatchObject({ status: "FAILED", stopReason: "ENQUEUE_FAILED", errorMessage: "could not enqueue", verified: false, eventCount: 0 });
      } finally { await cleanup?.(); }
    });

    it("pages history with a stable keyset cursor, filters by status, and isolates workspaces", async () => {
      const { store, cleanup } = await make();
      try {
        const ids: string[] = [];
        for (let i = 0; i < 5; i++) { const id = randomUUID(); ids.push(id); await store.create(newRow({ id, title: `inc ${i}` })); }
        await store.create(newRow({ id: randomUUID(), workspaceId: OTHER_WS, title: "foreign" }));
        await store.markCancelled(WS, ids[1]!); await store.markCancelled(WS, ids[3]!);
        const seen: string[] = []; let cursor: string | undefined; let pages = 0;
        do {
          const p = await store.listPage(WS, { limit: 2, ...(cursor ? { cursor } : {}) });
          expect(p.items.length).toBeLessThanOrEqual(2); seen.push(...p.items.map((r) => r.id)); cursor = p.nextCursor ?? undefined; pages++;
        } while (cursor && pages < 10);
        expect(pages).toBe(3); expect([...seen].sort()).toEqual([...ids].sort()); expect(new Set(seen).size).toBe(5);
        const cancelled = await store.listPage(WS, { status: "CANCELLED", limit: 10 });
        expect(cancelled.items.map((r) => r.id).sort()).toEqual([ids[1]!, ids[3]!].sort()); expect(cancelled.nextCursor).toBeNull();
        expect((await store.listPage(OTHER_WS)).items.map((r) => r.title)).toEqual(["foreign"]);
        await expect(store.listPage(WS, { cursor: "not-a-cursor" })).rejects.toBeInstanceOf(SentinelConflictError);
        expect((await store.list(WS, { limit: 3 }))).toHaveLength(3);
      } finally { await cleanup?.(); }
    });

    it("records and lists audit entries per workspace, and deletes only terminal investigations while retaining audit", async () => {
      const { store, id, cleanup } = await fresh();
      try {
        await store.recordAudit({ workspaceId: WS, investigationId: id, actorUserId: 3, action: "CREATE", detail: "tools=logs.search" });
        await store.recordAudit({ workspaceId: WS, investigationId: id, actorUserId: 4, action: "CANCEL_REQUESTED" });
        const audit = await store.listAudit(WS, id);
        expect(audit.map((a) => a.action).sort()).toEqual(["CANCEL_REQUESTED", "CREATE"]);
        expect(audit.find((a) => a.action === "CREATE")).toMatchObject({ actorUserId: 3, detail: "tools=logs.search", workspaceId: WS });
        expect(await store.listAudit(OTHER_WS, id)).toEqual([]);
        const ev = chain(id, 3); await store.appendEvents(WS, id, ev);
        expect(await store.deleteTerminal(WS, id)).toBe(false);                  // QUEUED: not deletable
        expect(await store.deleteTerminal(OTHER_WS, id)).toBe(false);
        await store.finalize(WS, id, summaryFor(ev));
        expect(await store.deleteTerminal(OTHER_WS, id)).toBe(false);
        expect(await store.deleteTerminal(WS, id)).toBe(true);
        expect(await store.get(WS, id)).toBeNull(); expect(await store.readEvents(WS, id)).toEqual([]);
        await store.recordAudit({ workspaceId: WS, investigationId: id, actorUserId: 3, action: "DELETE" });
        expect((await store.listAudit(WS, id)).map((a) => a.action)).toContain("DELETE");   // audit survives deletion
      } finally { await cleanup?.(); }
    });
  });
}
