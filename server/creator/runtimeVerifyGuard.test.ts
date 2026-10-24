import { describe, expect, it, vi } from "vitest";
import { createRuntimeVerifyGuard, RuntimeVerifyTimeoutError } from "./runtimeVerifyGuard";

/** Deterministic: injected clock and fake timers; no I/O. */
const clock = () => { let t = 1_000; return { now: () => t, advance: (ms: number) => { t += ms; } }; };

describe("runtime verify guard", () => {
  it("coalesces concurrent calls into one run and caches the value for the cooldown", async () => {
    const c = clock();
    const run = vi.fn(async () => "probe-result");
    const guard = createRuntimeVerifyGuard({ run, minIntervalMs: 10_000, timeoutMs: 20_000, now: c.now });
    const [a, b] = await Promise.all([guard.execute(), guard.execute()]);
    expect(run).toHaveBeenCalledTimes(1);
    expect([a.cached, b.cached].sort()).toEqual([false, true]);
    c.advance(9_999);
    expect(await guard.execute()).toMatchObject({ value: "probe-result", cached: true });
    expect(run).toHaveBeenCalledTimes(1);
    c.advance(2);
    expect(await guard.execute()).toMatchObject({ cached: false });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("does not cache a failure: the next call probes again", async () => {
    const c = clock();
    const run = vi.fn().mockRejectedValueOnce(new Error("storage down")).mockResolvedValueOnce("ok");
    const guard = createRuntimeVerifyGuard({ run, minIntervalMs: 10_000, timeoutMs: 20_000, now: c.now });
    await expect(guard.execute()).rejects.toThrow("storage down");
    expect(await guard.execute()).toMatchObject({ value: "ok", cached: false });
  });

  it("bounds execution: a hung probe times out, and further calls do not start new probes while it is still hung", async () => {
    vi.useFakeTimers();
    try {
      const run = vi.fn(() => new Promise<string>(() => undefined));
      const guard = createRuntimeVerifyGuard({ run, minIntervalMs: 10_000, timeoutMs: 5_000 });
      const first = guard.execute();
      const assertion = expect(first).rejects.toBeInstanceOf(RuntimeVerifyTimeoutError);
      await vi.advanceTimersByTimeAsync(5_001);
      await assertion;
      const second = guard.execute();
      const secondAssertion = expect(second).rejects.toBeInstanceOf(RuntimeVerifyTimeoutError);
      await vi.advanceTimersByTimeAsync(1);
      await secondAssertion;
      expect(run).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
});
