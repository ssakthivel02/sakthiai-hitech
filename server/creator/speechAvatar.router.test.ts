import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Speech/avatar generation through the real tRPC router + real orchestrator. Only the database, provider adapters,
 * readiness probe, spend ledger, consent store and audio resolution are faked. No network, no paid calls.
 */
const m = vi.hoisted(() => {
  const holds = new Map<string, { cost: number; state: string }>();
  const windows = { generations: 0, cost: 0 };
  const generations = new Map<string, number>();
  let nextId = 500;
  return {
    holds, windows, generations,
    limit: { cost: 100 },
    ledger: {
      reserve: async (input: { holdId: string; cost: number }) => {
        if (holds.has(input.holdId)) return { ok: true as const, created: false };
        if (windows.cost + input.cost > m.limit.cost) return { ok: false as const, reason: "workspace_exhausted" };
        windows.cost += input.cost;
        holds.set(input.holdId, { cost: input.cost, state: "HELD" });
        return { ok: true as const, created: true };
      },
      commit: async (holdId: string) => { const h = holds.get(holdId); if (h) h.state = "COMMITTED"; },
      release: async (holdId: string) => { const h = holds.get(holdId); if (h?.state === "HELD") { h.state = "RELEASED"; windows.cost -= h.cost; } },
      recordUnknown: async () => undefined,
    },
    speechSubmit: vi.fn(),
    avatarSubmit: vi.fn(),
    acceptance: vi.fn(),
    getWorkspaceForUser: vi.fn(),
    getWorkspaceRole: vi.fn(),
    findActiveConsent: vi.fn(),
    admitAvatarConsentDispatch: vi.fn(),
    recordConsent: vi.fn(async () => ({ consentId: 42 })),
    resolveAvatarAudio: vi.fn(),
    getGenerationExecutionContext: vi.fn(),
    createQueuedGeneration: vi.fn(async (input: { workspaceId: number; idempotencyKey: string }) => {
      const key = `${input.workspaceId}:${input.idempotencyKey}`;
      const existing = generations.get(key);
      if (existing) return { generationId: existing, created: false as const };
      const id = nextId++;
      generations.set(key, id);
      return { generationId: id, created: true as const };
    }),
  };
});

vi.mock("../db", async importOriginal => ({ ...(await importOriginal<typeof import("../db")>()), getWorkspaceForUser: m.getWorkspaceForUser, getWorkspaceRole: m.getWorkspaceRole }));
vi.mock("./runtimeAcceptance", () => ({ verifyCreatorRuntimeAcceptance: m.acceptance }));
vi.mock("./spendLedger", async importOriginal => ({ ...(await importOriginal<Record<string, unknown>>()), getCreatorSpendLedger: () => m.ledger }));
vi.mock("./speech/consentStore", async importOriginal => ({ ...(await importOriginal<Record<string, unknown>>()), findActiveConsent: m.findActiveConsent, admitAvatarConsentDispatch: m.admitAvatarConsentDispatch, recordConsent: m.recordConsent }));
vi.mock("./speech/audioAsset", () => ({ resolveAvatarAudio: m.resolveAvatarAudio }));
vi.mock("./persistence", () => ({
  beginProviderSubmission: vi.fn(async () => undefined),
  createQueuedGeneration: m.createQueuedGeneration,
  getGenerationExecutionContext: m.getGenerationExecutionContext,
  markGenerationFailed: vi.fn(async () => undefined),
  markGenerationSubmissionUnknown: vi.fn(async () => undefined),
  recordProviderPoll: vi.fn(async () => ({ generationState: "RUNNING" })),
  recordProviderSubmission: vi.fn(async () => undefined),
}));
vi.mock("./providerRegistry", () => {
  const make = (id: string, kind: string, defaultModel: string, submit: unknown) => ({
    id,
    status: () => ({ provider: id, configured: true, defaultModel, capabilities: {} }),
    supports: (request: { kind: string }) => request.kind === kind,
    submit, poll: vi.fn(), classifyFailure: () => "UNKNOWN",
  });
  const providers = [make("sarvam-tts", "SPEECH", "bulbul:v3", m.speechSubmit), make("heygen-avatar", "AVATAR_VIDEO", "heygen-v3", m.avatarSubmit)];
  return {
    listCreatorProviderStatuses: () => providers.map(p => p.status()),
    getCreatorProvider: (id: string) => providers.find(p => p.id === id),
    selectCreatorProvider: (request: { kind: string }) => {
      const p = providers.find(candidate => candidate.supports(request));
      if (!p) throw new Error(`CREATOR_NO_PROVIDER_SUPPORTS_${request.kind}`);
      return p;
    },
  };
});

import { randomUUID } from "node:crypto";
import { appRouter } from "../routers";
import type { TrpcContext } from "../_core/context";

const ENV: Record<string, string> = {
  CREATOR_PAID_GENERATION_ENABLED: "true",
  CREATOR_PAID_SPEECH_USERS: "speaker",
  CREATOR_PAID_AVATAR_USERS: "presenter",
  CREATOR_MODEL_COSTS: JSON.stringify({ "bulbul:v3": { perThousandChars: 0.5 }, "heygen-v3": { perSecond: 0.1 } }),
  CREATOR_GLOBAL_MAX_GENERATIONS_PER_DAY: "100", CREATOR_GLOBAL_MAX_COST_PER_DAY: "100",
  CREATOR_WORKSPACE_MAX_GENERATIONS_PER_DAY: "100", CREATOR_WORKSPACE_MAX_COST_PER_DAY: "100",
  CREATOR_USER_MAX_GENERATIONS_PER_DAY: "100", CREATOR_USER_MAX_COST_PER_DAY: "100",
};

let seq = 2000;
function caller(openId: string, role: "owner" | "member" = "owner") {
  const id = seq++;
  const now = new Date();
  m.getWorkspaceForUser.mockImplementation(async (uid: number, wid: number) => (uid === id && wid === 7 ? { id: 7 } : undefined));
  m.getWorkspaceRole.mockImplementation(async (uid: number, wid: number) => (uid === id && wid === 7 ? role : undefined));
  return appRouter.createCaller({
    req: {} as TrpcContext["req"], res: { headersSent: false, setHeader: vi.fn() } as unknown as TrpcContext["res"], requestId: "speech-avatar-test",
    user: { id, openId, name: openId, email: `${openId}@example.invalid`, loginMethod: "google", role: "user", createdAt: now, updatedAt: now, lastSignedIn: now },
  });
}

const target = (idempotencyKey: string = randomUUID()) => ({ workspaceId: 7, creatorProjectId: 1, shotId: 1, idempotencyKey });
const speech = (key?: string) => ({ ...target(key), text: "முருகா வேல் வேல் — Vetrivel" });
const avatar = (key?: string) => ({ ...target(key), avatarId: "avatar_ok_01", consentId: 3, audioAssetId: 9, live: true });

beforeEach(() => {
  vi.clearAllMocks();
  m.holds.clear(); m.generations.clear(); m.windows.cost = 0; m.limit.cost = 100;
  for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
  m.acceptance.mockResolvedValue({ readyForPaidGeneration: true, checks: [] });
  m.speechSubmit.mockImplementation(async () => ({ providerJobId: `creator/staging/speech/${randomUUID()}.wav`, state: "SUCCEEDED", provider: "sarvam-tts", model: "bulbul:v3", raw: {} }));
  m.avatarSubmit.mockImplementation(async () => ({ providerJobId: "vid_abc123", state: "SUBMITTED", provider: "heygen-avatar", model: "heygen-v3", raw: {} }));
  m.findActiveConsent.mockResolvedValue({ id: 3 });
  m.admitAvatarConsentDispatch.mockResolvedValue({ consentId: 3, admitted: true });
  m.resolveAvatarAudio.mockResolvedValue({ assetId: 9, data: new Uint8Array([1, 2, 3]), mimeType: "audio/wav", durationMs: 12_200 });
});
afterEach(() => vi.unstubAllEnvs());

describe("speech/avatar: default OFF and per-kind authorization", () => {
  it("feature switch OFF → FORBIDDEN, no generation row, no readiness probe, no provider", async () => {
    vi.stubEnv("CREATOR_PAID_GENERATION_ENABLED", "false");
    const api = caller("speaker");
    await expect(api.creator.speechAvatar.submitSpeech(speech())).rejects.toMatchObject({ code: "FORBIDDEN", message: "CREATOR_PAID_GENERATION_DISABLED" });
    await expect(api.creator.speechAvatar.submitAvatarVideo(avatar())).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(m.createQueuedGeneration).not.toHaveBeenCalled();
    expect(m.acceptance).not.toHaveBeenCalled();
    expect(m.speechSubmit).not.toHaveBeenCalled();
    expect(m.avatarSubmit).not.toHaveBeenCalled();
  });

  it("speech permission never implies avatar permission; non-owners are refused", async () => {
    await expect(caller("speaker").creator.speechAvatar.submitAvatarVideo(avatar())).rejects.toMatchObject({ code: "FORBIDDEN", message: "CREATOR_PAID_GENERATION_NOT_AUTHORIZED:AVATAR_VIDEO" });
    await expect(caller("speaker", "member").creator.speechAvatar.submitSpeech(speech())).rejects.toMatchObject({ code: "FORBIDDEN", message: "CREATOR_WORKSPACE_OWNER_REQUIRED" });
    expect(m.speechSubmit).not.toHaveBeenCalled();
    expect(m.avatarSubmit).not.toHaveBeenCalled();
  });
});

describe("speech generation", () => {
  it("reserves the per-character price before one provider call; a replayed key never calls the provider again", async () => {
    const api = caller("speaker");
    const key = randomUUID();
    const first = await api.creator.speechAvatar.submitSpeech(speech(key));
    expect(first).toMatchObject({ reused: false, state: "RUNNING", productionApproved: false });
    expect(m.speechSubmit).toHaveBeenCalledTimes(1);
    expect(m.speechSubmit.mock.calls[0][0]).toMatchObject({ kind: "SPEECH", prompt: "முருகா வேல் வேல் — Vetrivel", languageCode: "ta-IN" });
    const [hold] = [...m.holds.values()];
    expect(hold).toMatchObject({ state: "COMMITTED" });
    expect(hold.cost).toBeCloseTo(0.5 * ("முருகா வேல் வேல் — Vetrivel".length / 1000), 6);
    m.getGenerationExecutionContext.mockResolvedValue({ generation: { status: "RUNNING", provider: "sarvam-tts", outputAssetId: null }, providerJob: { status: "SUCCEEDED" } });
    const replay = await api.creator.speechAvatar.submitSpeech(speech(key));
    expect(replay).toMatchObject({ reused: true });
    expect(m.speechSubmit).toHaveBeenCalledTimes(1);
  });

  it("an exhausted budget stops before the provider and releases nothing it did not hold", async () => {
    m.limit.cost = 0;
    await expect(caller("speaker").creator.speechAvatar.submitSpeech(speech())).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: "CREATOR_BUDGET_EXHAUSTED:workspace" });
    expect(m.speechSubmit).not.toHaveBeenCalled();
  });
});

describe("avatar generation", () => {
  it("rejects undocumented free preview before access checks, readiness, consent, audio, ledger and provider", async () => {
    await expect(caller("presenter").creator.speechAvatar.submitAvatarVideo({ ...avatar(), live: false }))
      .rejects.toMatchObject({ code: "BAD_REQUEST", message: "AVATAR_V3_LIVE_APPROVAL_REQUIRED" });
    expect(m.acceptance).not.toHaveBeenCalled();
    expect(m.findActiveConsent).not.toHaveBeenCalled();
    expect(m.admitAvatarConsentDispatch).not.toHaveBeenCalled();
    expect(m.resolveAvatarAudio).not.toHaveBeenCalled();
    expect(m.createQueuedGeneration).not.toHaveBeenCalled();
    expect(m.holds.size).toBe(0);
    expect(m.avatarSubmit).not.toHaveBeenCalled();
  });

  it("revoked/absent consent stops before the audio read, the ledger and the provider", async () => {
    m.findActiveConsent.mockRejectedValue(new Error("CREATOR_CONSENT_REVOKED"));
    await expect(caller("presenter").creator.speechAvatar.submitAvatarVideo(avatar())).rejects.toMatchObject({ code: "BAD_REQUEST", message: "CREATOR_CONSENT_REVOKED" });
    expect(m.resolveAvatarAudio).not.toHaveBeenCalled();
    expect(m.holds.size).toBe(0);
    expect(m.avatarSubmit).not.toHaveBeenCalled();
  });

  it("revocation between initial lookup and provider dispatch releases the spend hold and never invokes HeyGen", async () => {
    m.admitAvatarConsentDispatch.mockRejectedValueOnce(new Error("CREATOR_CONSENT_REVOKED"));
    await expect(caller("presenter").creator.speechAvatar.submitAvatarVideo(avatar()))
      .rejects.toMatchObject({ code: "BAD_REQUEST", message: "CREATOR_CONSENT_REVOKED" });
    expect(m.findActiveConsent).toHaveBeenCalledTimes(1);
    expect(m.admitAvatarConsentDispatch).toHaveBeenCalledTimes(1);
    expect(m.avatarSubmit).not.toHaveBeenCalled();
    expect([...m.holds.values()]).toEqual([expect.objectContaining({ state: "RELEASED" })]);
    expect(m.windows.cost).toBe(0);
  });

  it("unapproved audio stops before the ledger and the provider", async () => {
    m.resolveAvatarAudio.mockRejectedValue(new Error("CREATOR_AVATAR_AUDIO_NOT_APPROVED"));
    await expect(caller("presenter").creator.speechAvatar.submitAvatarVideo(avatar())).rejects.toMatchObject({ code: "BAD_REQUEST", message: "CREATOR_AVATAR_AUDIO_NOT_APPROVED" });
    expect(m.holds.size).toBe(0);
    expect(m.avatarSubmit).not.toHaveBeenCalled();
  });

  it("passes server-resolved audio, binds consent, requires paid mode, and budgets the rounded-up audio seconds", async () => {
    const key = randomUUID();
    await caller("presenter").creator.speechAvatar.submitAvatarVideo(avatar(key));
    expect(m.findActiveConsent).toHaveBeenCalledWith({ workspaceId: 7, consentId: 3, purpose: "avatar_video", provider: "heygen-avatar", providerSubjectId: "avatar_ok_01" });
    const request = m.avatarSubmit.mock.calls[0][0];
    expect(request).toMatchObject({ kind: "AVATAR_VIDEO", avatarId: "avatar_ok_01", consentId: 3, audioAssetId: 9, expectedSeconds: 12.2, callbackId: key, live: true });
    expect(Array.from(request.audio.data)).toEqual([1, 2, 3]);
    expect([...m.holds.values()][0].cost).toBeCloseTo(1.3, 6);
  });

  it("an unpriced avatar model is refused before any generation row", async () => {
    vi.stubEnv("CREATOR_MODEL_COSTS", JSON.stringify({ "bulbul:v3": { perThousandChars: 0.5 } }));
    await expect(caller("presenter").creator.speechAvatar.submitAvatarVideo(avatar())).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: "CREATOR_MODEL_NOT_PRICED:heygen-v3" });
    expect(m.createQueuedGeneration).not.toHaveBeenCalled();
  });

  it("cancellation is refused honestly: the provider has no remote cancel", async () => {
    m.getGenerationExecutionContext.mockResolvedValue({ generation: { id: 501, status: "RUNNING", provider: "heygen-avatar" }, providerJob: { status: "RUNNING", providerJobId: "vid_abc123" } });
    await expect(caller("presenter").creator.cancelGeneration({ workspaceId: 7, generationId: 501 })).rejects.toMatchObject({ code: "BAD_REQUEST", message: "CREATOR_PROVIDER_CANCEL_UNSUPPORTED" });
  });
});

describe("speech review", () => {
  it("only the workspace owner may approve generated speech", async () => {
    await expect(caller("speaker", "member").creator.speechAvatar.reviewSpeech({ workspaceId: 7, creatorProjectId: 1, assetId: 5, decision: "PASS", notes: "ok" })).rejects.toMatchObject({ code: "FORBIDDEN", message: "CREATOR_WORKSPACE_OWNER_REQUIRED" });
    await expect(caller("speaker").creator.speechAvatar.reviewSpeech({ workspaceId: 7, creatorProjectId: 1, assetId: 5, decision: "PASS", notes: " " })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("consent records", () => {
  it("only a workspace owner may record consent; evidence is a reference of bounded length", async () => {
    await expect(caller("presenter", "member").creator.speechAvatar.recordConsent({ workspaceId: 7, purpose: "avatar_video", provider: "heygen-avatar", providerSubjectId: "avatar_ok_01", evidenceReference: "release-2026-11-001" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller("presenter").creator.speechAvatar.recordConsent({ workspaceId: 7, purpose: "avatar_video", provider: "heygen-avatar", providerSubjectId: "avatar_ok_01", evidenceReference: "short" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller("presenter").creator.speechAvatar.recordConsent({ workspaceId: 7, purpose: "avatar_video", provider: "heygen-avatar", providerSubjectId: "avatar_ok_01", evidenceReference: "release-2026-11-001" })).resolves.toEqual({ consentId: 42 });
  });
});
