import { describe, expect, it, vi } from "vitest";

vi.mock("../db", async importOriginal => ({ ...(await importOriginal<typeof import("../db")>()), getDb: vi.fn(async () => null) }));

import { appRouter } from "../routers";
import type { TrpcContext } from "../_core/context";

const ctx = (role: "user" | "admin" | null): TrpcContext => {
  const now = new Date();
  return {
    req: {} as TrpcContext["req"],
    res: { headersSent: false, setHeader: vi.fn() } as unknown as TrpcContext["res"],
    requestId: "spend-admin-test",
    user: role ? { id: 5, openId: `u-${role}`, name: "U", email: null, loginMethod: "oidc", role, createdAt: now, updatedAt: now, lastSignedIn: now } : null,
  };
};

describe("Creator spend admin endpoints", () => {
  const calls = (api: ReturnType<typeof appRouter.createCaller>) => [
    () => api.creator.spend.summary(),
    () => api.creator.spend.reconcile({ apply: true, staleAfterMinutes: 60 }),
    () => api.creator.spend.resolveHold({ holdId: "ws:1:x", outcome: "not_charged", note: "checked console" }),
  ];

  it("refuse unauthenticated callers and non-admin users (including workspace owners)", async () => {
    for (const role of [null, "user"] as const) {
      for (const call of calls(appRouter.createCaller(ctx(role)))) await expect(call()).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
  });

  it("administrator with the ledger unavailable gets a fail-closed PRECONDITION_FAILED, never partial data", async () => {
    for (const call of calls(appRouter.createCaller(ctx("admin")))) {
      await expect(call()).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: "CREATOR_SPEND_LEDGER_UNAVAILABLE" });
    }
  });

  it("reconcile refuses windows shorter than 15 minutes at the input boundary", async () => {
    await expect(appRouter.createCaller(ctx("admin")).creator.spend.reconcile({ apply: true, staleAfterMinutes: 5 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
