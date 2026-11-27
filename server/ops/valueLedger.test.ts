import { describe, expect, it, vi } from "vitest";

vi.mock("../db", async importOriginal => ({ ...(await importOriginal<typeof import("../db")>()), getDb: vi.fn(async () => null) }));

import { appRouter } from "../routers";
import type { TrpcContext } from "../_core/context";
import { MAX_LEDGER_DAYS, normalizeRange } from "./valueLedger";

const ctx = (role: "user" | "admin" | null): TrpcContext => {
  const now = new Date();
  return {
    req: {} as TrpcContext["req"],
    res: { headersSent: false, setHeader: vi.fn() } as unknown as TrpcContext["res"],
    requestId: "value-ledger-test",
    user: role ? { id: 5, openId: `u-${role}`, name: "U", email: null, loginMethod: "oidc", role, createdAt: now, updatedAt: now, lastSignedIn: now } : null,
  };
};

describe("Value Ledger range", () => {
  it("accepts inclusive real-calendar ranges up to the maximum and rejects everything else", () => {
    expect(normalizeRange({ from: "2026-10-01", to: "2026-10-01" }).days).toEqual(["2026-10-01"]);
    expect(normalizeRange({ from: "2026-02-27", to: "2026-03-01" }).days).toEqual(["2026-02-27", "2026-02-28", "2026-03-01"]);
    expect(normalizeRange({ from: "2026-10-01", to: "2026-10-31" }).days).toHaveLength(MAX_LEDGER_DAYS);
    expect(() => normalizeRange({ from: "2026-10-01", to: "2026-11-01" })).toThrow("VALUE_LEDGER_RANGE_TOO_LONG");
    for (const r of [{ from: "2026-10-02", to: "2026-10-01" }, { from: "2026-02-30", to: "2026-03-01" }, { from: "2026-1-01", to: "2026-10-01" }, { from: "x", to: "y" }]) {
      expect(() => normalizeRange(r)).toThrow("VALUE_LEDGER_RANGE_INVALID");
    }
  });
});

describe("Value Ledger endpoint", () => {
  it("refuses unauthenticated callers and non-admin users", async () => {
    for (const role of [null, "user"] as const) {
      await expect(appRouter.createCaller(ctx(role)).ops.valueLedger({ from: "2026-10-01", to: "2026-10-02" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
  });
  it("administrator without a database gets a fail-closed PRECONDITION_FAILED", async () => {
    await expect(appRouter.createCaller(ctx("admin")).ops.valueLedger({ from: "2026-10-01", to: "2026-10-02" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: "VALUE_LEDGER_DATABASE_UNAVAILABLE" });
  });
  it("malformed dates are refused at the input boundary", async () => {
    await expect(appRouter.createCaller(ctx("admin")).ops.valueLedger({ from: "yesterday", to: "2026-10-02" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
