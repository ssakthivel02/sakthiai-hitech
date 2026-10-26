import { describe, expect, it } from "vitest";
import { createSentinelInvestigateHandler } from "./handler";
import type { SentinelHandlerDeps } from "./handler";
import { InMemorySentinelStore } from "./testing";
import { verifyTrace } from "./engine/trace";
import { FakeTools, ID, WS, fakeCtx, goodModel, newRow } from "./testkit";

/**
 * Crash-injection sweep. The handler is killed at EVERY store write (before the write reaches the store, and after it was persisted but before the
 * caller learns of it) and at every task checkpoint, then re-run until it finishes. For every crash point the final state must equal an uninterrupted run:
 * same outcome, one verified gap-free hash chain, exactly one closing event, row summary consistent with the stored events, and no read-only call repeated
 * more than the documented at-least-once window (one call per crash).
 */
const MUTATORS = ["markRunning", "appendEvents", "finalize"] as const;
type Mutator = (typeof MUTATORS)[number];

const deps = (store: InMemorySentinelStore, tools: FakeTools): SentinelHandlerDeps => ({
  store, mcp: { callTool: async () => { throw new Error("mcp must not be used"); } }, enabled: () => true,
  config: () => ({ policyTimeoutMs: 5000, toolAttemptTimeoutMs: 2000, maxModelCalls: 24, formatRetries: 1, cancelPollMs: 20 }),
  transportFor: () => tools, modelFor: () => goodModel(),
});

async function seeded() {
  const store = new InMemorySentinelStore();
  const r = await store.create(newRow());
  await store.attachTask(r.workspaceId, r.id, "22222222-2222-4222-8222-222222222222");
  return store;
}

/** Wrap the store so the n-th call to any mutator (counted across mutators) fails, either before or after it takes effect. */
function crashing(store: InMemorySentinelStore, at: number, when: "before" | "after") {
  let n = 0; let fired = false;
  const proxy = new Proxy(store, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv);
      if (typeof v !== "function" || !MUTATORS.includes(prop as Mutator)) return typeof v === "function" ? v.bind(target) : v;
      return async (...args: unknown[]) => {
        n += 1;
        const hit = !fired && n === at;
        if (hit && when === "before") { fired = true; throw new Error("simulated process crash (before write)"); }
        const out = await (v as (...a: unknown[]) => Promise<unknown>).apply(target, args);
        if (hit && when === "after") { fired = true; throw new Error("simulated process crash (after write)"); }
        return out;
      };
    },
  });
  return { store: proxy as InMemorySentinelStore, count: () => n };
}

async function runToCompletion(base: InMemorySentinelStore, wrap: (s: InMemorySentinelStore) => InMemorySentinelStore, onCrash?: () => void) {
  const allTools: FakeTools[] = [];
  let crashes = 0;
  for (let attempt = 1; attempt <= 6; attempt++) {
    const tools = new FakeTools(); tools.n = attempt * 100; allTools.push(tools);
    try {
      const out = await createSentinelInvestigateHandler(deps(wrap(base), tools))(fakeCtx({ attempt }).ctx);
      return { out: out as { status: string; label: string | null; outcome: string | null; verified: boolean | null }, tools: allTools, crashes };
    } catch (e) {
      if (!/simulated process crash/.test(String((e as Error).message))) throw e;
      crashes += 1; onCrash?.();
    }
  }
  throw new Error("did not finish within 6 attempts");
}

describe("crash-injection sweep over every store write", () => {
  it("the uninterrupted baseline completes and tells us how many writes to sweep", async () => {
    const store = await seeded();
    const probe = crashing(store, Number.MAX_SAFE_INTEGER, "before");
    const { out, tools } = await runToCompletion(store, () => probe.store);
    expect(out).toMatchObject({ status: "COMPLETED", label: "DISK_FULL", outcome: "DIAGNOSIS", verified: true });
    expect(tools.flatMap((t) => t.calls)).toHaveLength(2);
    expect(probe.count()).toBeGreaterThanOrEqual(5);
  });

  it("every crash point converges on the same verified result, one closing event, no gaps, bounded repeats", async () => {
    // Baseline write count
    const b = await seeded(); const probe = crashing(b, Number.MAX_SAFE_INTEGER, "before");
    await runToCompletion(b, () => probe.store);
    const writes = probe.count();
    const baselineEvents = (await b.readEvents(WS, ID)).map((e) => e.type).filter((t) => t !== "resumed");

    let swept = 0;
    for (const when of ["before", "after"] as const) {
      for (let at = 1; at <= writes; at++) {
        const store = await seeded();
        const c = crashing(store, at, when);
        const { out, tools, crashes } = await runToCompletion(store, () => c.store);
        const where = `${when} write #${at}`;
        expect(crashes, where).toBe(1);
        expect(out, where).toMatchObject({ status: "COMPLETED", label: "DISK_FULL", outcome: "DIAGNOSIS", verified: true });

        const events = await store.readEvents(WS, ID);
        expect(verifyTrace(events, ID).ok, where).toBe(true);
        expect(events.map((e) => e.seq), where).toEqual(events.map((_, i) => i));          // gap-free, no duplicate seq
        expect(events.filter((e) => e.type === "final"), where).toHaveLength(1);
        expect(events.map((e) => e.type).filter((t) => t !== "resumed"), where).toEqual(baselineEvents);

        const row = (await store.get(WS, ID))!;
        expect(row.status, where).toBe("COMPLETED");
        expect(row.eventCount, where).toBe(events.length);
        expect(row.traceHead, where).toBe(events[events.length - 1]!.hash);

        // Read-only calls: baseline 2, plus at most one re-execution per crash (the documented at-least-once window).
        const calls = tools.flatMap((t) => t.calls).length;
        expect(calls, where).toBeGreaterThanOrEqual(2);
        expect(calls, where).toBeLessThanOrEqual(2 + crashes);
        swept += 1;
      }
    }
    expect(swept).toBe(writes * 2);
  });

  it("a crash inside the task checkpoint call (lease/heartbeat path) also converges", async () => {
    for (let k = 1; k <= 8; k++) {
      const store = await seeded();
      let crashed = false; const all: FakeTools[] = [];
      let out: { status: string; label: string | null } | null = null;
      for (let attempt = 1; attempt <= 4 && !out; attempt++) {
        const tools = new FakeTools(); tools.n = attempt * 100; all.push(tools);
        const ctx = fakeCtx({ attempt, onCheckpoint: (c) => { if (!crashed && c === k) { crashed = true; throw new Error("simulated process crash (checkpoint)"); } } }).ctx;
        try { out = await createSentinelInvestigateHandler(deps(store, tools))(ctx) as { status: string; label: string | null }; }
        catch (e) { if (!/simulated process crash/.test(String((e as Error).message))) throw e; }
      }
      expect(out, `checkpoint #${k}`).toMatchObject({ status: "COMPLETED", label: "DISK_FULL" });
      const events = await store.readEvents(WS, ID);
      expect(verifyTrace(events, ID).ok, `checkpoint #${k}`).toBe(true);
      expect(events.filter((e) => e.type === "final"), `checkpoint #${k}`).toHaveLength(1);
      expect(all.flatMap((t) => t.calls).length, `checkpoint #${k}`).toBeLessThanOrEqual(3);
    }
  });
});
