import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P-G10: Creator runtime preflight / data-plane verification are OPERATOR functions.
 * preflight spawns a process (ffmpeg -version) and reports infrastructure configuration state; verifyRuntime runs a
 * 12-query database schema probe and a storage write/read/delete canary against shared infrastructure. Both are
 * global (not per-tenant) and every signed-in user owns a personal workspace, so a workspace-membership check does not
 * restrict them. They require the global administrator role. Only the database lookup and the probes are faked:
 * no network, no managed database, no provider.
 */
const m = vi.hoisted(() => ({
  getWorkspaceForUser: vi.fn(),
  verify: vi.fn(),
  preflight: vi.fn(),
}));

vi.mock("../db", async importOriginal => ({
  ...(await importOriginal<typeof import("../db")>()),
  getWorkspaceForUser: m.getWorkspaceForUser,
}));
vi.mock("./runtimeAcceptance", () => ({ verifyCreatorRuntimeAcceptance: m.verify }));
vi.mock("./runtimePreflight", async importOriginal => ({
  ...(await importOriginal<typeof import("./runtimePreflight")>()),
  buildCreatorRuntimePreflight: m.preflight,
}));

import { appRouter } from "../routers";
import type { TrpcContext } from "../_core/context";
import { resetCreatorRuntimeVerifyGuardForTests } from "./router";

let userSeq = 5000;
function caller(role: "user" | "admin") {
  const now = new Date();
  const id = userSeq++;
  const ctx: TrpcContext = {
    req: {} as TrpcContext["req"],
    res: { headersSent: false, setHeader: vi.fn() } as unknown as TrpcContext["res"],
    requestId: "runtime-access-test",
    user: { id, openId: `u${id}`, name: `u${id}`, email: `u${id}@example.invalid`, loginMethod: "google", role, createdAt: now, updatedAt: now, lastSignedIn: now },
  };
  return { api: appRouter.createCaller(ctx), id };
}
const anonymous = () =>
  appRouter.createCaller({ req: {} as TrpcContext["req"], res: { headersSent: false, setHeader: vi.fn() } as unknown as TrpcContext["res"], requestId: "anon", user: null });

const PRE = { readyForPaidGeneration: false, productionApproved: false as const, checks: [{ id: "DATABASE_CONFIGURED", required: true, pass: true, detail: "ok" }] };
const ACCEPT = { ...PRE, checks: [...PRE.checks, { id: "STORAGE_WRITE_READ_VERIFIED", required: true, pass: true, detail: "ok" }] };
const ownWorkspace = (userId: number, workspaceId = 7) =>
  m.getWorkspaceForUser.mockImplementation(async (uid: number, wid: number) => (uid === userId && wid === workspaceId ? { id: wid } : undefined));

const calls = (api: ReturnType<typeof caller>["api"], workspaceId = 7) => ({
  preflight: () => api.creator.preflight({ workspaceId }),
  verifyRuntime: () => api.creator.verifyRuntime({ workspaceId }),
});

beforeEach(() => {
  vi.clearAllMocks();
  resetCreatorRuntimeVerifyGuardForTests();
  m.preflight.mockReturnValue(PRE);
  m.verify.mockResolvedValue(ACCEPT);
});
afterEach(() => vi.restoreAllMocks());

describe("P-G10 creator.preflight / creator.verifyRuntime authorization", () => {
  it.each(["preflight", "verifyRuntime"] as const)("%s: an ordinary signed-in user who owns their own workspace is FORBIDDEN and no probe runs", async name => {
    const { api, id } = caller("user");
    ownWorkspace(id);
    await expect(calls(api)[name]()).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(m.preflight).not.toHaveBeenCalled();
    expect(m.verify).not.toHaveBeenCalled();
  });

  it.each(["preflight", "verifyRuntime"] as const)("%s: unauthenticated → UNAUTHORIZED, no probe", async name => {
    const api = anonymous();
    await expect(calls(api as never)[name]()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(m.preflight).not.toHaveBeenCalled();
    expect(m.verify).not.toHaveBeenCalled();
  });

  it.each(["preflight", "verifyRuntime"] as const)("%s: an administrator keeps access to a workspace they belong to", async name => {
    const { api, id } = caller("admin");
    ownWorkspace(id);
    const result = await calls(api)[name]();
    expect(result).toMatchObject({ productionApproved: false });
    expect(name === "preflight" ? m.preflight : m.verify).toHaveBeenCalledTimes(1);
  });

  it.each(["preflight", "verifyRuntime"] as const)("%s: an administrator is still refused another tenant's workspace (isolation retained), no probe", async name => {
    const { api, id } = caller("admin");
    ownWorkspace(id, 7);
    await expect(calls(api, 8)[name]()).rejects.toMatchObject({ code: "FORBIDDEN", message: "Workspace access denied" });
    expect(m.preflight).not.toHaveBeenCalled();
    expect(m.verify).not.toHaveBeenCalled();
  });

  it("the paid-generation spend admin surface stays admin-only (unchanged)", async () => {
    const { api } = caller("user");
    await expect(api.creator.spend.summary()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("P-G10 verifyRuntime is bounded, throttled and audited", () => {
  it("concurrent administrator calls share one probe; a call inside the cooldown reuses the result", async () => {
    const { api, id } = caller("admin");
    ownWorkspace(id);
    let release: (value: typeof ACCEPT) => void = () => undefined;
    m.verify.mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
    const first = calls(api).verifyRuntime();
    const second = calls(api).verifyRuntime();
    await vi.waitFor(() => expect(m.verify).toHaveBeenCalledTimes(1));
    release(ACCEPT);
    await expect(Promise.all([first, second])).resolves.toEqual([ACCEPT, ACCEPT]);
    await expect(calls(api).verifyRuntime()).resolves.toEqual(ACCEPT);
    expect(m.verify).toHaveBeenCalledTimes(1);
  });

  it("writes one secret-free audit line per call naming user, workspace, outcome and check ids only", async () => {
    const { api, id } = caller("admin");
    ownWorkspace(id);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await calls(api).verifyRuntime();
    const lines = log.mock.calls.map(c => String(c[0])).filter(line => line.includes("creator.runtime_verify"));
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]);
    expect(entry).toMatchObject({ event: "creator.runtime_verify", userId: id, workspaceId: 7, ready: false, cached: false });
    expect(entry.failedChecks).toEqual([]);
    expect(lines[0]).not.toMatch(/secret|password|token|key|mysql:\/\//i);
  });
});
