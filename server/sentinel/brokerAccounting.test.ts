import { describe, expect, it } from "vitest";
import { Broker } from "./engine/broker";
import { caseFromRecord } from "./caseDoc";
import { newRow } from "./testkit";
import { hashOf } from "./engine/canon";
import type { BackendOutcome, ToolTransport } from "./engine/transport";

const c = () => caseFromRecord(newRow() as never);
const outcome = (kind: string, virtual_ms: unknown): BackendOutcome => ({ kind, virtual_ms, ...(kind === "ok" ? { obs: [] } : kind === "error" ? { code: "UPSTREAM_ERROR" } : {}) }) as BackendOutcome;

describe("adapter accounting cannot corrupt broker budgets", () => {
  it.each(["ok", "error", "timeout"].flatMap(kind => [-1, NaN, Infinity, -Infinity, Number.MAX_VALUE, "10", undefined].map(ms => [kind, ms] as const)))("rejects malformed %s duration %s without retry", async (kind, ms) => {
    let calls = 0;
    const transport: ToolTransport = { exec: () => { calls++; return outcome(kind, ms); } };
    for (const asyncPath of [false, true]) {
      const b = new Broker(c(), transport);
      const request = { tool: "logs.search", target: "orders-db" };
      const before = calls;
      const result = asyncPath ? await b.callAsync(request) : b.call(request);
      expect(result).toMatchObject({ status: "ERROR", error: "ADAPTER_CONTRACT_VIOLATION", attempts: 1, records: [] });
      expect(calls - before).toBe(1);
      expect(Number.isFinite(b.stats.virtual_ms)).toBe(true);
      expect(b.stats.virtual_ms).toBeGreaterThanOrEqual(0);
      expect(b.timeLeft).toBeLessThanOrEqual(c().limits.max_virtual_ms);
      expect(b.violations).toHaveLength(1);
      const restored = new Broker(c(), transport);
      restored.restore(b.results);
      expect(restored.stats).toEqual(b.stats);
    }
  });
  it.each(["ok", "error", "timeout"])("preserves valid zero-duration %s output", kind => {
    const b = new Broker(c(), { exec: () => outcome(kind, 0) });
    const r = b.call({ tool: "logs.search", target: "orders-db" });
    expect(r.status).toBe(kind === "ok" ? "NO_DATA" : kind === "error" ? "ERROR" : "TIMEOUT");
    expect(b.violations).toEqual([]);
    expect(b.stats.virtual_ms).toBe(0);
  });
  it("rejects a self-consistently hashed non-finite restored duration atomically", () => {
    const original = new Broker(c(), { exec: () => outcome("ok", 1) });
    original.call({ tool: "logs.search", target: "orders-db" });
    const r = { ...original.results[0]!, virtual_ms: Infinity };
    r.result_hash = hashOf({ ...r, result_hash: undefined });
    const restored = new Broker(c(), { exec: () => outcome("ok", 1) });
    expect(() => restored.restore([r])).toThrow("VIRTUAL_MS");
    expect(restored.results).toEqual([]);
    expect(restored.stats.virtual_ms).toBe(0);
  });
});
