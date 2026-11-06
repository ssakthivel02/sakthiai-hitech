import { describe, expect, it } from "vitest";
import { UploadCleanupRunner, cleanupConfigFromEnv, type CleanupConfig } from "./cleanupRunner";

const cfg = (o: Partial<CleanupConfig> = {}): CleanupConfig => ({ enabled: true, intervalMs: 1000, batchLimit: 10, maxBatchesPerRun: 3, retentionDays: 7, finalizingStaleSeconds: 300, ...o });
const report = (n: number, truncated: boolean) => ({ expired: n, recovered: 0, purgedChunkRows: n * 2, deletedSessions: 0, truncated });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe("upload cleanup runner", () => {
  it("is OFF by default (exact 'true' only) and bounds every setting", () => {
    expect(cleanupConfigFromEnv({}).enabled).toBe(false);
    for (const v of ["1", "TRUE", "yes", ""]) expect(cleanupConfigFromEnv({ UPLOAD_CLEANUP_ENABLED: v }).enabled).toBe(false);
    expect(cleanupConfigFromEnv({ UPLOAD_CLEANUP_ENABLED: "true" }).enabled).toBe(true);
    expect(cleanupConfigFromEnv({ UPLOAD_CLEANUP_INTERVAL_MS: "5" }).intervalMs).toBe(600_000);
    expect(cleanupConfigFromEnv({ UPLOAD_CLEANUP_BATCH_LIMIT: "999999" }).batchLimit).toBe(200);
    expect(cleanupConfigFromEnv({ UPLOAD_CLEANUP_RETENTION_DAYS: "0" }).retentionDays).toBe(7);
    expect(cleanupConfigFromEnv({ UPLOAD_CLEANUP_BATCH_LIMIT: "50", UPLOAD_CLEANUP_MAX_BATCHES: "5" })).toMatchObject({ batchLimit: 50, maxBatchesPerRun: 5 });
  });
  it("disabled: never touches the store, reports 'disabled'", async () => {
    const store = { cleanup: async () => { throw new Error("must not run"); } };
    const r = new UploadCleanupRunner({ store, config: cfg({ enabled: false }) });
    r.start(); expect(await r.runOnce()).toEqual({ status: "skipped_disabled" });
    expect(r.status().state).toBe("disabled"); expect(await r.stop()).toEqual({ drained: true });
  });
  it("is bounded: keeps batching only while truncated, never more than maxBatchesPerRun, passing the batch limit", async () => {
    const seen: any[] = []; let n = 0;
    const store = { cleanup: async (o: any) => { seen.push(o); n += 1; return report(1, true); } };
    const r = new UploadCleanupRunner({ store, config: cfg() });
    const out = await r.runOnce();
    expect(out).toMatchObject({ status: "ran", batches: 3, truncated: true }); expect(n).toBe(3);
    expect(seen.every(o => o.batchLimit === 10 && o.retentionDays === 7 && o.finalizingStaleSeconds === 300)).toBe(true);
    expect(r.status()).toMatchObject({ runs: 1, lastTruncated: true, totals: { expired: 3, purgedChunkRows: 6 } });
    let m = 0; const small = new UploadCleanupRunner({ store: { cleanup: async () => { m += 1; return report(0, false); } }, config: cfg() });
    expect(await small.runOnce()).toMatchObject({ batches: 1, truncated: false }); expect(m).toBe(1);
  });
  it("single-flight: a call during a run is skipped, never overlapped", async () => {
    let live = 0, peak = 0;
    const store = { cleanup: async () => { live++; peak = Math.max(peak, live); await sleep(80); live--; return report(0, false); } };
    const r = new UploadCleanupRunner({ store, config: cfg() });
    const [a, b, c] = await Promise.all([r.runOnce(), r.runOnce(), r.runOnce()]);
    expect([a.status, b.status, c.status].sort()).toEqual(["ran", "skipped_busy", "skipped_busy"]);
    expect(peak).toBe(1); expect(r.status().skippedBusy).toBe(2);
    expect(await r.runOnce()).toMatchObject({ status: "ran" }); // free again afterwards
  });
  it("store errors never throw out; health degrades after 3 and recovers", async () => {
    let fail = true;
    const store = { cleanup: async () => { if (fail) throw new Error("db down"); return report(0, false); } };
    const r = new UploadCleanupRunner({ store, config: cfg() });
    for (let i = 0; i < 3; i++) expect(await r.runOnce()).toEqual({ status: "error" });
    expect(r.status()).toMatchObject({ healthy: false, consecutiveErrors: 3, lastError: "db down" });
    fail = false; await r.runOnce();
    expect(r.status()).toMatchObject({ healthy: true, consecutiveErrors: 0, lastError: null });
  });
  it("scheduled runs fire on the interval; stop waits for an in-flight run and halts the schedule", async () => {
    let runs = 0; const store = { cleanup: async () => { runs += 1; await sleep(60); return report(0, false); } };
    const r = new UploadCleanupRunner({ store, config: cfg({ intervalMs: 1000 }) });
    // use the real timer with a short interval via a custom config bypass: intervalMs min is 1000 in env parsing, not in the class
    const fast = new UploadCleanupRunner({ store, config: cfg({ intervalMs: 40 }) });
    fast.start(); await sleep(250);
    expect(runs).toBeGreaterThanOrEqual(2);
    expect(await fast.stop(1000)).toEqual({ drained: true });
    const after = runs; await sleep(150); expect(runs).toBe(after); expect(fast.status().state).toBe("stopped");
    void r;
  });
  it("stop with an expired grace reports drained=false and refuses to start a new run", async () => {
    const store = { cleanup: async () => { await sleep(300); return report(0, false); } };
    const r = new UploadCleanupRunner({ store, config: cfg({ intervalMs: 20 }) });
    r.start(); await sleep(60);
    expect((await r.stop(20)).drained).toBe(false);
    expect(r.status().runs).toBe(0);
  });
});
