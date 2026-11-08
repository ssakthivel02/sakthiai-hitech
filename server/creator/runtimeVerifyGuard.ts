/**
 * Bounds the Creator data-plane verification (12-query schema probe + storage write/read/delete canary), which runs
 * against shared infrastructure: concurrent callers share ONE run, a fresh result is reused for `minIntervalMs`, and a
 * hung probe is abandoned to the caller after `timeoutMs` without starting another probe on top of it.
 */
export class RuntimeVerifyTimeoutError extends Error {
  constructor() { super("CREATOR_RUNTIME_VERIFY_TIMEOUT"); this.name = "RuntimeVerifyTimeoutError"; }
}

export type RuntimeVerifyGuardOptions<T> = { run: () => Promise<T>; minIntervalMs: number; timeoutMs: number; now?: () => number };

export function createRuntimeVerifyGuard<T>(options: RuntimeVerifyGuardOptions<T>) {
  const now = options.now ?? Date.now;
  let inFlight: { promise: Promise<T>; startedAt: number } | null = null;
  let last: { at: number; value: T } | null = null;

  const withDeadline = (promise: Promise<T>, remainingMs: number) =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new RuntimeVerifyTimeoutError()), Math.max(0, remainingMs));
      promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
    });

  return {
    async execute(): Promise<{ value: T; cached: boolean; durationMs: number }> {
      const t = now();
      if (inFlight) return { value: await withDeadline(inFlight.promise, options.timeoutMs - (t - inFlight.startedAt)), cached: true, durationMs: 0 };
      if (last && t - last.at < options.minIntervalMs) return { value: last.value, cached: true, durationMs: 0 };
      const started = { promise: options.run(), startedAt: t };
      inFlight = started;
      // The slot is released only when the probe itself settles, so a hung probe is never stacked with a new one.
      started.promise.then(
        value => { last = { at: now(), value }; if (inFlight === started) inFlight = null; },
        () => { if (inFlight === started) inFlight = null; },
      );
      const value = await withDeadline(started.promise, options.timeoutMs);
      return { value, cached: false, durationMs: now() - t };
    },
    reset() { inFlight = null; last = null; },
  };
}
