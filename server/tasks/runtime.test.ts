import { describe, expect, it } from "vitest";
import { runtimeConfigFromEnv, TaskWorkerRuntime } from "./runtime";
import { asyncAnswersEnabled } from "./shared";

describe("task worker runtime configuration", () => {
  it("is OFF by default and only enabled by the exact string 'true'", () => {
    expect(runtimeConfigFromEnv({}).enabled).toBe(false);
    for (const v of ["1", "TRUE", "yes", "", " true"]) expect(runtimeConfigFromEnv({ TASK_WORKER_ENABLED: v }).enabled).toBe(false);
    expect(runtimeConfigFromEnv({ TASK_WORKER_ENABLED: "true" }).enabled).toBe(true);
    expect(asyncAnswersEnabled({})).toBe(false);
    expect(asyncAnswersEnabled({ TASK_WORKER_ENABLED: "true" })).toBe(true);
  });
  it("bounds concurrency and timings, falling back to safe defaults on garbage", () => {
    expect(runtimeConfigFromEnv({ TASK_WORKER_CONCURRENCY: "100" }).concurrency).toBe(2);
    expect(runtimeConfigFromEnv({ TASK_WORKER_CONCURRENCY: "0" }).concurrency).toBe(2);
    expect(runtimeConfigFromEnv({ TASK_WORKER_CONCURRENCY: "abc" }).concurrency).toBe(2);
    expect(runtimeConfigFromEnv({ TASK_WORKER_CONCURRENCY: "8" }).concurrency).toBe(8);
    expect(runtimeConfigFromEnv({ TASK_WORKER_LEASE_MS: "5" }).leaseMs).toBe(30_000);
    expect(runtimeConfigFromEnv({ TASK_WORKER_POLL_MS: "-1" }).pollMs).toBe(1000);
  });
  it("a disabled runtime never starts, never touches the store and reports 'disabled'", async () => {
    const store: any = new Proxy({}, { get() { throw new Error("store must not be touched"); } });
    const rt = new TaskWorkerRuntime({ store, handlers: {}, config: runtimeConfigFromEnv({}) });
    rt.start();
    expect(rt.status()).toMatchObject({ enabled: false, state: "disabled", inFlight: 0, healthy: true });
    expect(await rt.stop(0)).toEqual({ drained: true, abandonedInFlight: 0 });
  });
  it("a failing store never throws out of the runtime; it reports unhealthy and keeps retrying", async () => {
    const store: any = { claim: async () => { throw new Error("db down"); } };
    const rt = new TaskWorkerRuntime({ store, handlers: { x: async () => 1 }, config: { enabled: true, concurrency: 1, pollMs: 50, leaseMs: 1000, shutdownGraceMs: 100 } });
    rt.start();
    await new Promise(r => setTimeout(r, 400));
    const s = rt.status();
    expect(s.state).toBe("running"); expect(s.consecutiveErrors).toBeGreaterThanOrEqual(2); expect(s.lastError).toBe("db down");
    expect((await rt.stop(500)).drained).toBe(true);
    expect(rt.status().state).toBe("stopped");
  });
});
