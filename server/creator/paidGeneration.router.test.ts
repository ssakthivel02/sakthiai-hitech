import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P0 Creator paid-generation security, exercised through the real tRPC router + real orchestrator.
 * Only the database, provider adapters, readiness probe and spend ledger are faked. No network, no paid calls.
 */
const m = vi.hoisted(() => {
  type Limits = Record<"globalGenerations" | "globalCost" | "workspaceGenerations" | "workspaceCost" | "userGenerations" | "userCost", number>;
  const windows = new Map<string, { generations: number; cost: number }>();
  const holds = new Map<string, { scopes: string[]; cost: number; state: "HELD" | "COMMITTED" | "RELEASED"; generationId?: number }>();
  const ledger = {
    fail: false,
    reserve: async (input: { holdId: string; workspaceId: number; userId: number; cost: number; limits: Limits }) => {
      if (ledger.fail) throw new Error("ledger down");
      if (holds.has(input.holdId)) return { ok: true as const, created: false };
      const scopes: Array<[string, number, number, string]> = [
        ["global", input.limits.globalGenerations, input.limits.globalCost, "global_exhausted"],
        [`workspace:${input.workspaceId}`, input.limits.workspaceGenerations, input.limits.workspaceCost, "workspace_exhausted"],
        [`user:${input.userId}`, input.limits.userGenerations, input.limits.userCost, "user_exhausted"],
      ];
      for (const [scope, maxGen, maxCost, reason] of scopes) {
        const w = windows.get(scope) ?? { generations: 0, cost: 0 };
        if (w.generations + 1 > maxGen || w.cost + input.cost > maxCost) return { ok: false as const, reason };
      }
      for (const [scope] of scopes) {
        const w = windows.get(scope) ?? { generations: 0, cost: 0 };
        windows.set(scope, { generations: w.generations + 1, cost: w.cost + input.cost });
      }
      holds.set(input.holdId, { scopes: scopes.map(s => s[0]), cost: input.cost, state: "HELD" });
      return { ok: true as const, created: true };
    },
    commit: async (holdId: string, generationId: number) => {
      const h = holds.get(holdId);
      if (h?.state === "HELD") Object.assign(h, { state: "COMMITTED", generationId });
    },
    release: async (holdId: string) => {
      const h = holds.get(holdId);
      if (h?.state !== "HELD") return;
      h.state = "RELEASED";
      for (const scope of h.scopes) {
        const w = windows.get(scope)!;
        windows.set(scope, { generations: w.generations - 1, cost: w.cost - h.cost });
      }
    },
    recordUnknown: async (holdId: string, generationId: number) => {
      const h = holds.get(holdId);
      if (h) h.generationId = generationId;
    },
  };

  const generations = new Map<string, number>();
  let nextId = 100;
  return {
    windows,
    holds,
    ledger,
    generations,
    providerSubmit: vi.fn(),
    providerPoll: vi.fn(),
    providerCancel: vi.fn(),
    classifyFailure: vi.fn(() => "UNKNOWN"),
    providerConfigured: { value: true },
    acceptance: vi.fn(),
    getWorkspaceForUser: vi.fn(),
    getWorkspaceRole: vi.fn(),
    createQueuedGeneration: vi.fn(async (input: { workspaceId: number; idempotencyKey: string }) => {
      const key = `${input.workspaceId}:${input.idempotencyKey}`;
      const existing = generations.get(key);
      if (existing) return { generationId: existing, created: false as const };
      const id = nextId++;
      generations.set(key, id);
      return { generationId: id, created: true as const };
    }),
    getGenerationExecutionContext: vi.fn(),
    markGenerationFailed: vi.fn(async () => undefined),
    markGenerationSubmissionUnknown: vi.fn(async () => undefined),
  };
});

vi.mock("../db", async importOriginal => ({
  ...(await importOriginal<typeof import("../db")>()),
  getWorkspaceForUser: m.getWorkspaceForUser,
  getWorkspaceRole: m.getWorkspaceRole,
}));
vi.mock("./runtimeAcceptance", () => ({ verifyCreatorRuntimeAcceptance: m.acceptance }));
vi.mock("./referenceResolution", () => ({ resolveApprovedProjectReferenceImages: vi.fn(async () => []) }));
vi.mock("./conditionedFrameAsset", () => ({ resolveApprovedConditionedFrameAsset: vi.fn() }));
vi.mock("./spendLedger", async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCreatorSpendLedger: () => m.ledger,
}));
vi.mock("./persistence", () => ({
  beginProviderSubmission: vi.fn(async () => undefined),
  createQueuedGeneration: m.createQueuedGeneration,
  getGenerationExecutionContext: m.getGenerationExecutionContext,
  markGenerationFailed: m.markGenerationFailed,
  markGenerationSubmissionUnknown: m.markGenerationSubmissionUnknown,
  recordProviderPoll: vi.fn(async () => ({ generationState: "RUNNING" })),
  recordProviderSubmission: vi.fn(async () => undefined),
}));
vi.mock("./providerRegistry", () => {
  const make = (id: string, kinds: string[], defaultModel: string) => ({
    id,
    status: () => ({ provider: id, configured: m.providerConfigured.value, defaultModel, capabilities: {} }),
    supports: (request: { kind: string }) => kinds.includes(request.kind),
    submit: m.providerSubmit,
    poll: m.providerPoll,
    cancel: m.providerCancel,
    classifyFailure: m.classifyFailure,
  });
  const providers = [make("google-image", ["IMAGE", "IMAGE_EDIT"], "gemini-3.1-flash-image"), make("google-veo", ["VIDEO"], "veo-3.1-fast-generate-preview")];
  return {
    listCreatorProviderStatuses: () => providers.map(p => p.status()),
    getCreatorProvider: (id: string) => providers.find(p => p.id === id),
    selectCreatorProvider: (request: { kind: string }) => {
      const p = providers.find(candidate => candidate.supports(request));
      if (!p) throw new Error(`CREATOR_NO_PROVIDER_SUPPORTS_${request.kind}`);
      if (!p.status().configured) throw new Error(`CREATOR_PROVIDER_NOT_CONFIGURED_${request.kind}`);
      return p;
    },
  };
});

import { randomUUID } from "node:crypto";
import { appRouter } from "../routers";
import type { TrpcContext } from "../_core/context";

const PAID_ENV: Record<string, string> = {
  CREATOR_PAID_GENERATION_ENABLED: "true",
  CREATOR_PAID_IMAGE_USERS: "approved-image,approved-both",
  CREATOR_PAID_VIDEO_USERS: "approved-video,approved-both",
  CREATOR_MODEL_COSTS: JSON.stringify({ "gemini-3.1-flash-image": { perGeneration: 0.05 }, "veo-3.1-fast-generate-preview": { perSecond: 0.1 } }),
  CREATOR_GLOBAL_MAX_GENERATIONS_PER_DAY: "100",
  CREATOR_GLOBAL_MAX_COST_PER_DAY: "100",
  CREATOR_WORKSPACE_MAX_GENERATIONS_PER_DAY: "100",
  CREATOR_WORKSPACE_MAX_COST_PER_DAY: "100",
  CREATOR_USER_MAX_GENERATIONS_PER_DAY: "100",
  CREATOR_USER_MAX_COST_PER_DAY: "100",
};

let userSeq = 1000;
function caller(openId: string, role: "user" | "admin" = "user", id = userSeq++) {
  const now = new Date();
  const ctx: TrpcContext = {
    req: {} as TrpcContext["req"],
    res: { headersSent: false, setHeader: vi.fn() } as unknown as TrpcContext["res"],
    requestId: "creator-paid-test",
    user: { id, openId, name: openId, email: `${openId}@example.invalid`, loginMethod: "google", role, createdAt: now, updatedAt: now, lastSignedIn: now },
  };
  return { api: appRouter.createCaller(ctx), id };
}
const anonymous = () =>
  appRouter.createCaller({ req: {} as TrpcContext["req"], res: { headersSent: false, setHeader: vi.fn() } as unknown as TrpcContext["res"], requestId: "anon", user: null });

const image = (workspaceId = 7, idempotencyKey: string = randomUUID()) => ({ workspaceId, creatorProjectId: 1, shotId: 1, idempotencyKey, prompt: "Murugan temple at dawn" });
const video = (workspaceId = 7, idempotencyKey: string = randomUUID()) => ({ ...image(workspaceId, idempotencyKey), durationSeconds: 8 as const });

function ownWorkspaces(userId: number, workspaces: number[] = [7], role: "owner" | "member" = "owner") {
  m.getWorkspaceForUser.mockImplementation(async (uid: number, wid: number) => (uid === userId && workspaces.includes(wid) ? { id: wid } : undefined));
  m.getWorkspaceRole.mockImplementation(async (uid: number, wid: number) => (uid === userId && workspaces.includes(wid) ? role : undefined));
}

beforeEach(() => {
  vi.clearAllMocks();
  m.windows.clear();
  m.holds.clear();
  m.generations.clear();
  m.ledger.fail = false;
  m.providerConfigured.value = true;
  for (const [k, v] of Object.entries(PAID_ENV)) vi.stubEnv(k, v);
  m.acceptance.mockResolvedValue({ readyForPaidGeneration: true, checks: [] });
  m.providerSubmit.mockImplementation(async () => ({ providerJobId: `job-${randomUUID()}`, state: "RUNNING", raw: {} }));
  m.classifyFailure.mockReturnValue("UNKNOWN");
});
afterEach(() => vi.unstubAllEnvs());

describe("Creator paid generation: feature switch (default OFF)", () => {
  it.each([undefined, "", "false", "TRUE ", "1", "yes"])("flag %j → FORBIDDEN, zero provider calls, no generation row", async value => {
    if (value === undefined) vi.stubEnv("CREATOR_PAID_GENERATION_ENABLED", undefined as unknown as string);
    else vi.stubEnv("CREATOR_PAID_GENERATION_ENABLED", value);
    const { api, id } = caller("approved-both", "admin");
    ownWorkspaces(id);
    await expect(api.creator.submitImage(image())).rejects.toMatchObject({ code: "FORBIDDEN", message: "CREATOR_PAID_GENERATION_DISABLED" });
    await expect(api.creator.submitVideo(video())).rejects.toMatchObject({ code: "FORBIDDEN", message: "CREATOR_PAID_GENERATION_DISABLED" });
    expect(m.providerSubmit).not.toHaveBeenCalled();
    expect(m.createQueuedGeneration).not.toHaveBeenCalled();
    expect(m.acceptance).not.toHaveBeenCalled(); // no storage canary for denied requests
    expect(m.holds.size).toBe(0);
  });
});

describe("Creator paid generation: identity and authorization", () => {
  it("unauthenticated → UNAUTHORIZED, zero provider calls", async () => {
    await expect(anonymous().creator.submitImage(image())).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(m.providerSubmit).not.toHaveBeenCalled();
  });

  it("authenticated Google user not on any allowlist → FORBIDDEN before readiness, ledger or provider", async () => {
    const { api, id } = caller("random-google-user");
    ownWorkspaces(id);
    await expect(api.creator.submitImage(image())).rejects.toMatchObject({ code: "FORBIDDEN", message: "CREATOR_PAID_GENERATION_NOT_AUTHORIZED:IMAGE" });
    await expect(api.creator.submitVideo(video())).rejects.toMatchObject({ code: "FORBIDDEN", message: "CREATOR_PAID_GENERATION_NOT_AUTHORIZED:VIDEO" });
    expect(m.providerSubmit).not.toHaveBeenCalled();
    expect(m.acceptance).not.toHaveBeenCalled();
    expect(m.holds.size).toBe(0);
  });

  it("image permission does not grant video, and video permission does not grant image", async () => {
    const img = caller("approved-image");
    ownWorkspaces(img.id);
    await expect(img.api.creator.submitVideo(video())).rejects.toMatchObject({ code: "FORBIDDEN", message: "CREATOR_PAID_GENERATION_NOT_AUTHORIZED:VIDEO" });
    await expect(img.api.creator.submitImage(image())).resolves.toMatchObject({ reused: false });
    const vid = caller("approved-video");
    ownWorkspaces(vid.id);
    await expect(vid.api.creator.submitImage(image())).rejects.toMatchObject({ code: "FORBIDDEN", message: "CREATOR_PAID_GENERATION_NOT_AUTHORIZED:IMAGE" });
    await expect(vid.api.creator.submitVideo(video())).resolves.toMatchObject({ reused: false });
    expect(m.providerSubmit).toHaveBeenCalledTimes(2);
  });

  it("allowlist matching is exact (no prefix/substring/case tricks)", async () => {
    for (const openId of ["approved-imag", "approved-image-x", "APPROVED-IMAGE", " approved-image"]) {
      const { api, id } = caller(openId);
      ownWorkspaces(id);
      await expect(api.creator.submitImage(image())).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    expect(m.providerSubmit).not.toHaveBeenCalled();
  });

  it("administrator is authorized for both kinds without allowlisting", async () => {
    const { api, id } = caller("some-admin", "admin");
    ownWorkspaces(id);
    await expect(api.creator.submitImage(image())).resolves.toMatchObject({ reused: false });
    await expect(api.creator.submitVideo(video())).resolves.toMatchObject({ reused: false });
  });
});

describe("Creator paid generation: workspace ownership and tenant isolation", () => {
  it("approved user submitting into another tenant's workspace → FORBIDDEN, zero provider calls", async () => {
    const { api, id } = caller("approved-both");
    ownWorkspaces(id, [7]);
    await expect(api.creator.submitImage(image(8))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(api.creator.submitVideo(video(8))).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(m.providerSubmit).not.toHaveBeenCalled();
    expect(m.holds.size).toBe(0);
  });

  it("workspace member who is not the owner → FORBIDDEN CREATOR_WORKSPACE_OWNER_REQUIRED", async () => {
    const { api, id } = caller("approved-both");
    ownWorkspaces(id, [7], "member");
    await expect(api.creator.submitImage(image())).rejects.toMatchObject({ code: "FORBIDDEN", message: "CREATOR_WORKSPACE_OWNER_REQUIRED" });
    expect(m.providerSubmit).not.toHaveBeenCalled();
  });

  it("membership lookup unavailable (database down) → denied, fail closed", async () => {
    const { api } = caller("approved-both");
    m.getWorkspaceForUser.mockResolvedValue({ id: 7 });
    m.getWorkspaceRole.mockResolvedValue(undefined);
    await expect(api.creator.submitImage(image())).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(m.providerSubmit).not.toHaveBeenCalled();
  });
});

describe("Creator paid generation: spend policy fails closed", () => {
  it.each([
    "CREATOR_MODEL_COSTS",
    "CREATOR_GLOBAL_MAX_GENERATIONS_PER_DAY",
    "CREATOR_GLOBAL_MAX_COST_PER_DAY",
    "CREATOR_WORKSPACE_MAX_GENERATIONS_PER_DAY",
    "CREATOR_WORKSPACE_MAX_COST_PER_DAY",
    "CREATOR_USER_MAX_GENERATIONS_PER_DAY",
    "CREATOR_USER_MAX_COST_PER_DAY",
  ])("missing %s while enabled → PRECONDITION_FAILED, zero provider calls", async name => {
    vi.stubEnv(name, "");
    const { api, id } = caller("approved-both");
    ownWorkspaces(id);
    await expect(api.creator.submitImage(image())).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringMatching(/^CREATOR_SPEND_POLICY_INVALID/) });
    expect(m.providerSubmit).not.toHaveBeenCalled();
  });

  it.each(["0", "-1", "abc", "1e400", "NaN"])("invalid limit value %j → denied", async value => {
    vi.stubEnv("CREATOR_GLOBAL_MAX_COST_PER_DAY", value);
    const { api, id } = caller("approved-both");
    ownWorkspaces(id);
    await expect(api.creator.submitImage(image())).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(m.providerSubmit).not.toHaveBeenCalled();
  });

  it("malformed cost table → denied", async () => {
    vi.stubEnv("CREATOR_MODEL_COSTS", "{not json");
    const { api, id } = caller("approved-both");
    ownWorkspaces(id);
    await expect(api.creator.submitImage(image())).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(m.providerSubmit).not.toHaveBeenCalled();
  });

  it("model without a configured price → denied before reservation and provider", async () => {
    vi.stubEnv("CREATOR_MODEL_COSTS", JSON.stringify({ "gemini-3.1-flash-image": { perGeneration: 0.05 } }));
    const { api, id } = caller("approved-both");
    ownWorkspaces(id);
    await expect(api.creator.submitVideo(video())).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: "CREATOR_MODEL_NOT_PRICED:veo-3.1-fast-generate-preview" });
    expect(m.providerSubmit).not.toHaveBeenCalled();
    expect(m.holds.size).toBe(0);
  });

  it("spend ledger unavailable → PRECONDITION_FAILED, zero provider calls, generation recorded as FAILED/QUOTA", async () => {
    m.ledger.fail = true;
    const { api, id } = caller("approved-both");
    ownWorkspaces(id);
    await expect(api.creator.submitImage(image())).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: "CREATOR_SPEND_LEDGER_UNAVAILABLE" });
    expect(m.providerSubmit).not.toHaveBeenCalled();
    expect(m.markGenerationFailed).toHaveBeenCalledWith(expect.objectContaining({ failureClass: "QUOTA", errorMessage: "CREATOR_SPEND_LEDGER_UNAVAILABLE" }));
  });

  it("runtime readiness failure after authorization → no reservation is left behind", async () => {
    m.acceptance.mockResolvedValue({ readyForPaidGeneration: false, checks: [{ id: "storage", required: true, pass: false }] });
    const { api, id } = caller("approved-both");
    ownWorkspaces(id);
    await expect(api.creator.submitImage(image())).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(m.providerSubmit).not.toHaveBeenCalled();
    expect([...m.windows.values()].every(w => w.generations === 0)).toBe(true);
  });

  it("missing/invalid provider credentials → no reservation and no provider call", async () => {
    m.providerConfigured.value = false;
    const { api, id } = caller("approved-both");
    ownWorkspaces(id);
    await expect(api.creator.submitImage(image())).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(m.providerSubmit).not.toHaveBeenCalled();
    expect(m.holds.size).toBe(0);
  });
});

describe("Creator paid generation: budgets", () => {
  it("cost is reserved before the provider is invoked", async () => {
    const order: string[] = [];
    const reserve = m.ledger.reserve;
    const spy = vi.spyOn(m.ledger, "reserve").mockImplementation(async input => { order.push("reserve"); return reserve(input); });
    m.providerSubmit.mockImplementation(async () => { order.push("provider"); return { providerJobId: "job-1", state: "RUNNING", raw: {} }; });
    const { api, id } = caller("approved-both");
    ownWorkspaces(id);
    await api.creator.submitVideo(video());
    expect(order).toEqual(["reserve", "provider"]);
    expect(spy.mock.calls[0][0]).toMatchObject({ cost: 0.8, kind: "VIDEO", model: "veo-3.1-fast-generate-preview" }); // 8 s × 0.1
    spy.mockRestore();
  });

  it("exhausted global budget blocks every workspace", async () => {
    vi.stubEnv("CREATOR_GLOBAL_MAX_GENERATIONS_PER_DAY", "1");
    const a = caller("approved-both");
    ownWorkspaces(a.id, [7]);
    await a.api.creator.submitImage(image(7));
    const b = caller("approved-both");
    ownWorkspaces(b.id, [9]);
    await expect(b.api.creator.submitImage(image(9))).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: "CREATOR_BUDGET_EXHAUSTED:global" });
    expect(m.providerSubmit).toHaveBeenCalledTimes(1);
  });

  it("exhausted global cost budget blocks an expensive video but not a cheap image", async () => {
    vi.stubEnv("CREATOR_GLOBAL_MAX_COST_PER_DAY", "0.5");
    const { api, id } = caller("approved-both");
    ownWorkspaces(id);
    await expect(api.creator.submitVideo(video())).rejects.toMatchObject({ message: "CREATOR_BUDGET_EXHAUSTED:global" });
    await expect(api.creator.submitImage(image())).resolves.toMatchObject({ reused: false });
    expect(m.providerSubmit).toHaveBeenCalledTimes(1);
  });

  it("exhausted workspace budget", async () => {
    vi.stubEnv("CREATOR_WORKSPACE_MAX_GENERATIONS_PER_DAY", "1");
    const { api, id } = caller("approved-both");
    ownWorkspaces(id);
    await api.creator.submitImage(image());
    await expect(api.creator.submitImage(image())).rejects.toMatchObject({ message: "CREATOR_BUDGET_EXHAUSTED:workspace" });
    expect(m.providerSubmit).toHaveBeenCalledTimes(1);
  });

  it("exhausted user budget follows the user across their workspaces", async () => {
    vi.stubEnv("CREATOR_USER_MAX_GENERATIONS_PER_DAY", "1");
    const { api, id } = caller("approved-both");
    ownWorkspaces(id, [7, 9]);
    await api.creator.submitImage(image(7));
    await expect(api.creator.submitImage(image(9))).rejects.toMatchObject({ message: "CREATOR_BUDGET_EXHAUSTED:user" });
    expect(m.providerSubmit).toHaveBeenCalledTimes(1);
  });

  it("fresh idempotency keys cannot evade the budget", async () => {
    vi.stubEnv("CREATOR_USER_MAX_GENERATIONS_PER_DAY", "2");
    const { api, id } = caller("approved-both");
    ownWorkspaces(id);
    await api.creator.submitImage(image());
    await api.creator.submitImage(image());
    await expect(api.creator.submitImage(image())).rejects.toMatchObject({ message: "CREATOR_BUDGET_EXHAUSTED:user" });
    expect(m.providerSubmit).toHaveBeenCalledTimes(2);
  });

  it("concurrent submissions: exactly the allowed number reach the provider", async () => {
    vi.stubEnv("CREATOR_WORKSPACE_MAX_GENERATIONS_PER_DAY", "2");
    const { api, id } = caller("approved-both");
    ownWorkspaces(id);
    const results = await Promise.allSettled([api.creator.submitImage(image()), api.creator.submitImage(image()), api.creator.submitImage(image())]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(2);
    expect(results.filter(r => r.status === "rejected").map(r => (r as PromiseRejectedResult).reason.message)).toEqual(["CREATOR_BUDGET_EXHAUSTED:workspace"]);
    expect(m.providerSubmit).toHaveBeenCalledTimes(2);
  });

  it("duplicate idempotency key: one reservation, one provider call, second response is reused", async () => {
    const key = randomUUID();
    const { api, id } = caller("approved-both");
    ownWorkspaces(id);
    const first = await api.creator.submitImage(image(7, key));
    m.getGenerationExecutionContext.mockResolvedValue({ generation: { id: first!.generationId, provider: "google-image", status: "RUNNING" }, providerJob: { status: "RUNNING" } });
    const second = await api.creator.submitImage(image(7, key));
    expect(first).toMatchObject({ reused: false });
    expect(second).toMatchObject({ reused: true, generationId: first!.generationId });
    expect(m.providerSubmit).toHaveBeenCalledTimes(1);
    expect(m.windows.get("global")).toEqual({ generations: 1, cost: 0.05 });
  });
});

describe("Creator paid generation: provider failures and settlement", () => {
  it("successful submission commits the reservation to the generation", async () => {
    const { api, id } = caller("approved-both");
    ownWorkspaces(id);
    const result = await api.creator.submitImage(image());
    const [hold] = [...m.holds.values()];
    expect(hold).toMatchObject({ state: "COMMITTED", generationId: result!.generationId });
  });

  it("definitive provider rejection releases the reservation", async () => {
    m.providerSubmit.mockRejectedValue(new Error("GOOGLE_IMAGE_HTTP_400"));
    m.classifyFailure.mockReturnValue("VALIDATION");
    const { api, id } = caller("approved-both");
    ownWorkspaces(id);
    await expect(api.creator.submitImage(image())).rejects.toBeTruthy();
    expect([...m.holds.values()][0].state).toBe("RELEASED");
    expect(m.windows.get("global")).toEqual({ generations: 0, cost: 0 });
  });

  it("ambiguous failure (timeout) keeps the reservation counted and never resubmits", async () => {
    m.providerSubmit.mockRejectedValue(new Error("timeout"));
    m.classifyFailure.mockReturnValue("TIMEOUT");
    const key = randomUUID();
    const { api, id } = caller("approved-both");
    ownWorkspaces(id);
    await expect(api.creator.submitImage(image(7, key))).rejects.toBeTruthy();
    const [hold] = [...m.holds.values()];
    expect(hold.state).toBe("HELD");
    expect(hold.generationId).toBeDefined();
    expect(m.windows.get("global")).toEqual({ generations: 1, cost: 0.05 });
    // Same key again: must not reach the provider a second time.
    m.getGenerationExecutionContext.mockResolvedValue({ generation: { id: hold.generationId, provider: "google-image", status: "SUBMISSION_UNKNOWN" }, providerJob: null });
    await expect(api.creator.submitImage(image(7, key))).resolves.toMatchObject({ reused: true });
    expect(m.providerSubmit).toHaveBeenCalledTimes(1);
  });

  it("pre-submission failure (unknown shot) creates no reservation and no provider call", async () => {
    m.createQueuedGeneration.mockRejectedValueOnce(new Error("CREATOR_SHOT_NOT_FOUND"));
    const { api, id } = caller("approved-both");
    ownWorkspaces(id);
    await expect(api.creator.submitImage(image())).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(m.holds.size).toBe(0);
    expect(m.providerSubmit).not.toHaveBeenCalled();
  });

  it("budget denial is recorded on the generation and the same key is never resubmitted", async () => {
    vi.stubEnv("CREATOR_GLOBAL_MAX_GENERATIONS_PER_DAY", "1");
    const { api, id } = caller("approved-both");
    ownWorkspaces(id);
    await api.creator.submitImage(image());
    const key = randomUUID();
    await expect(api.creator.submitImage(image(7, key))).rejects.toMatchObject({ message: "CREATOR_BUDGET_EXHAUSTED:global" });
    expect(m.markGenerationFailed).toHaveBeenCalledWith(expect.objectContaining({ failureClass: "QUOTA", errorMessage: "CREATOR_BUDGET_EXHAUSTED:global" }));
    expect(m.providerSubmit).toHaveBeenCalledTimes(1);
  });
});

describe("Creator existing provider-job operations", () => {
  const gen = (kind: string) => ({ generation: { id: 55, provider: kind === "VIDEO" ? "google-veo" : "google-image", kind, status: "RUNNING", failureClass: null }, providerJob: { providerJobId: "job-55", status: "RUNNING" } });

  it("retry requires the feature switch", async () => {
    vi.stubEnv("CREATOR_PAID_GENERATION_ENABLED", "false");
    const { api, id } = caller("approved-both");
    ownWorkspaces(id);
    m.getGenerationExecutionContext.mockResolvedValue(gen("VIDEO"));
    await expect(api.creator.retryGeneration({ workspaceId: 7, generationId: 55 })).rejects.toMatchObject({ code: "FORBIDDEN", message: "CREATOR_PAID_GENERATION_DISABLED" });
    expect(m.providerPoll).not.toHaveBeenCalled();
    expect(m.providerSubmit).not.toHaveBeenCalled();
  });

  it("retry requires permission for the generation's own kind and workspace ownership", async () => {
    const img = caller("approved-image");
    ownWorkspaces(img.id);
    m.getGenerationExecutionContext.mockResolvedValue(gen("VIDEO"));
    await expect(img.api.creator.retryGeneration({ workspaceId: 7, generationId: 55 })).rejects.toMatchObject({ code: "FORBIDDEN", message: "CREATOR_PAID_GENERATION_NOT_AUTHORIZED:VIDEO" });
    const member = caller("approved-both");
    ownWorkspaces(member.id, [7], "member");
    await expect(member.api.creator.retryGeneration({ workspaceId: 7, generationId: 55 })).rejects.toMatchObject({ code: "FORBIDDEN", message: "CREATOR_WORKSPACE_OWNER_REQUIRED" });
    expect(m.providerPoll).not.toHaveBeenCalled();
    expect(m.providerSubmit).not.toHaveBeenCalled();
  });

  it("cancel stays available when the feature is OFF (stopping spend is never blocked) but requires the owner", async () => {
    vi.stubEnv("CREATOR_PAID_GENERATION_ENABLED", "false");
    m.getGenerationExecutionContext.mockResolvedValue(gen("VIDEO"));
    const member = caller("random-user");
    ownWorkspaces(member.id, [7], "member");
    await expect(member.api.creator.cancelGeneration({ workspaceId: 7, generationId: 55 })).rejects.toMatchObject({ code: "FORBIDDEN", message: "CREATOR_WORKSPACE_OWNER_REQUIRED" });
    expect(m.providerCancel).not.toHaveBeenCalled();
    const outsider = caller("approved-both");
    ownWorkspaces(outsider.id, [9]);
    await expect(outsider.api.creator.cancelGeneration({ workspaceId: 7, generationId: 55 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(m.providerCancel).not.toHaveBeenCalled();
  });

  it("poll of another tenant's generation is denied", async () => {
    const outsider = caller("approved-both");
    ownWorkspaces(outsider.id, [9]);
    await expect(outsider.api.creator.pollGeneration({ workspaceId: 7, generationId: 55 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(m.providerPoll).not.toHaveBeenCalled();
  });
});

describe("Creator-specific throttling", () => {
  it("submissions are throttled per user independently of budgets (4th within a minute)", async () => {
    const { api, id } = caller("approved-both");
    ownWorkspaces(id);
    for (let i = 0; i < 3; i++) await api.creator.submitImage(image());
    await expect(api.creator.submitImage(image())).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(m.providerSubmit).toHaveBeenCalledTimes(3);
  });
});
