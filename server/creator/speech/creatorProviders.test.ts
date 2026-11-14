import { describe, expect, it, vi } from "vitest";
import { createHeygenAvatarProvider, createSarvamSpeechProvider, SPEECH_STAGING_PREFIX } from "./creatorProviders";
import { makePcmWav } from "./wav";
import { HEYGEN_ENDPOINTS } from "./heygenAvatar";
import { SpeechProviderError } from "./types";
import { assertConsentActive } from "./consentStore";
import { validateAvatarAudioAsset } from "./audioAsset";
import { assetTypeForGeneration, extensionForCreatorMimeType } from "../artifactPersistence";
import { estimateCreatorCost, isAuthorizedForPaidKind, paidKindOf, readCreatorPaidConfig } from "../paidPolicy";

describe("Sarvam speech provider on the Creator seam", () => {
  const synth = vi.fn(async () => ({ wav: makePcmWav(900), durationMs: 900, sha256: "x".repeat(64), model: "bulbul:v3" as const, languageCode: "ta-IN" as const, characters: 5, chunkCount: 1, providerRequestIds: ["r1"] }));

  it("synthesises once, stages the billed audio under a random private key, then polls and fetches only that key", async () => {
    const store = new Map<string, Buffer>();
    const provider = createSarvamSpeechProvider({ synthesize: synth, put: async (k, d) => { store.set(k, d); return { key: k }; }, read: async k => store.get(k)! });
    const submission = await provider.submit({ kind: "SPEECH", prompt: "முருகா" });
    expect(submission.state).toBe("SUCCEEDED");
    expect(submission.providerJobId.startsWith(SPEECH_STAGING_PREFIX)).toBe(true);
    expect(synth).toHaveBeenCalledTimes(1);
    const poll = await provider.poll(submission.providerJobId);
    expect(poll).toMatchObject({ state: "SUCCEEDED", artifacts: [{ mimeType: "audio/wav", uri: submission.providerJobId }] });
    const fetched = await provider.fetchArtifact!(poll.artifacts[0]);
    expect(fetched.mimeType).toBe("audio/wav");
    expect(Buffer.from(fetched.data).equals(store.get(submission.providerJobId)!)).toBe(true);
    expect(synth).toHaveBeenCalledTimes(1); // polling never re-synthesises (never re-bills)
  });

  it("refuses any key outside the staging pattern (no arbitrary storage read via provider job id)", async () => {
    const read = vi.fn();
    const provider = createSarvamSpeechProvider({ synthesize: synth, read });
    for (const uri of ["creator/1/2/renders/x.mp4", "creator/staging/speech/../../secrets.wav", "creator/staging/speech/abc.wav"]) {
      await expect(provider.poll(uri)).rejects.toMatchObject({ code: "SPEECH_STAGING_KEY_INVALID" });
      await expect(provider.fetchArtifact!({ mimeType: "audio/wav", uri })).rejects.toMatchObject({ code: "SPEECH_STAGING_KEY_INVALID" });
    }
    expect(read).not.toHaveBeenCalled();
  });

  it("only supports SPEECH, reports configuration from the dedicated key, and has no remote cancel", () => {
    const provider = createSarvamSpeechProvider({ apiKeyPresent: () => false });
    expect(provider.supports({ kind: "SPEECH", prompt: "x" })).toBe(true);
    expect(provider.supports({ kind: "IMAGE", prompt: "x" })).toBe(false);
    expect(provider.status().configured).toBe(false);
    expect(provider.cancel).toBeUndefined();
  });

  it("maps adapter errors to Creator failure classes", () => {
    const provider = createSarvamSpeechProvider();
    expect(provider.classifyFailure(new SpeechProviderError("x", "RATE_LIMIT", true))).toBe("RATE_LIMIT");
    expect(provider.classifyFailure(new Error("storage down"))).toBe("UNKNOWN"); // ambiguous: billed audio may exist
  });
});

describe("HeyGen avatar provider on the Creator seam", () => {
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypmp42"), Buffer.alloc(32)]);
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
  const fetchMock = vi.fn(async (url: string) => {
    if (url === HEYGEN_ENDPOINTS.upload) return json({ data: { asset_id: "asset_abc123" } });
    if (url === HEYGEN_ENDPOINTS.generate) return json({ data: { video_id: "vid_abc123" } });
    if (url.startsWith(HEYGEN_ENDPOINTS.status)) return json({ data: { status: "completed", video_url: "https://resource.heygen.ai/v.mp4", duration: 2 } });
    return new Response(new Uint8Array(mp4));
  });
  const provider = createHeygenAvatarProvider({ heygen: { fetch: fetchMock, apiKey: "k" } });
  const request = { kind: "AVATAR_VIDEO" as const, prompt: "t", avatarId: "avatar_ok_01", consentId: 3, audioAssetId: 9, expectedSeconds: 2, callbackId: "11111111-2222-3333-4444-555555555555", live: true };

  it("refuses to submit without server-resolved audio", async () => {
    await expect(provider.submit(request)).rejects.toMatchObject({ code: "AVATAR_AUDIO_NOT_RESOLVED" });
  });

  it("blocks direct provider free-mode calls before any upload", async () => {
    fetchMock.mockClear();
    await expect(provider.submit({ ...request, live: false, audio: { mimeType: "audio/wav", data: new Uint8Array(makePcmWav(500)) } }))
      .rejects.toMatchObject({ code: "AVATAR_V3_LIVE_APPROVAL_REQUIRED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("submits a contracted v3 avatar only when explicitly billed, polls to MP4 and has no remote cancel", async () => {
    const submission = await provider.submit({ ...request, audio: { mimeType: "audio/wav", data: new Uint8Array(makePcmWav(500)) } });
    expect(submission).toMatchObject({ providerJobId: "vid_abc123", state: "SUBMITTED", raw: { testMode: false } });
    const poll = await provider.poll("vid_abc123");
    expect(poll.state).toBe("SUCCEEDED");
    expect((await provider.fetchArtifact!(poll.artifacts[0])).mimeType).toBe("video/mp4");
    expect(provider.cancel).toBeUndefined();
  });
});

describe("consent and approved-audio validation", () => {
  const row = { id: 1, workspaceId: 7, purpose: "avatar_video" as const, provider: "heygen-avatar", providerSubjectId: "avatar_ok_01", validUntil: null, revokedAt: null };
  const want = { workspaceId: 7, purpose: "avatar_video" as const, provider: "heygen-avatar", providerSubjectId: "avatar_ok_01" };
  it("accepts only an unrevoked, unexpired record of this workspace, purpose, provider and subject", () => {
    expect(assertConsentActive(row, want).id).toBe(1);
    expect(() => assertConsentActive(undefined, want)).toThrow("CREATOR_CONSENT_NOT_FOUND");
    expect(() => assertConsentActive({ ...row, workspaceId: 8 }, want)).toThrow("CREATOR_CONSENT_NOT_FOUND");
    expect(() => assertConsentActive({ ...row, purpose: "custom_voice" }, want)).toThrow("CREATOR_CONSENT_PURPOSE_MISMATCH");
    expect(() => assertConsentActive({ ...row, providerSubjectId: "someone_else" }, want)).toThrow("CREATOR_CONSENT_SUBJECT_MISMATCH");
    expect(() => assertConsentActive({ ...row, revokedAt: new Date() }, want)).toThrow("CREATOR_CONSENT_REVOKED");
    expect(() => assertConsentActive({ ...row, validUntil: new Date(Date.now() - 1000) }, want)).toThrow("CREATOR_CONSENT_EXPIRED");
  });

  const audio = { id: 9, workspaceId: 7, creatorProjectId: 1, assetType: "AUDIO_MASTER", mimeType: "audio/wav", storageKey: "k", immutable: 1, reviewDecision: "APPROVED", byteSize: 1000 };
  it("drives avatars only from approved, immutable WAV audio of the same workspace and project", () => {
    expect(validateAvatarAudioAsset(audio, { workspaceId: 7, creatorProjectId: 1 }).id).toBe(9);
    expect(() => validateAvatarAudioAsset({ ...audio, workspaceId: 8 }, { workspaceId: 7, creatorProjectId: 1 })).toThrow("CREATOR_AVATAR_AUDIO_SCOPE_MISMATCH");
    expect(() => validateAvatarAudioAsset({ ...audio, reviewDecision: "PENDING" }, { workspaceId: 7, creatorProjectId: 1 })).toThrow("CREATOR_AVATAR_AUDIO_NOT_APPROVED");
    expect(() => validateAvatarAudioAsset({ ...audio, immutable: 0 }, { workspaceId: 7, creatorProjectId: 1 })).toThrow("CREATOR_AVATAR_AUDIO_MUTABLE");
    expect(() => validateAvatarAudioAsset({ ...audio, assetType: "VIDEO" }, { workspaceId: 7, creatorProjectId: 1 })).toThrow("CREATOR_AVATAR_AUDIO_NOT_AUDIO");
    expect(() => validateAvatarAudioAsset({ ...audio, mimeType: "audio/mpeg" }, { workspaceId: 7, creatorProjectId: 1 })).toThrow("CREATOR_AVATAR_AUDIO_MIME_UNSUPPORTED");
  });
});

describe("pricing, allowlists and asset mapping for the new kinds", () => {
  const env = {
    CREATOR_PAID_GENERATION_ENABLED: "true",
    CREATOR_MODEL_COSTS: JSON.stringify({ "bulbul:v3": { perThousandChars: 0.5 }, "heygen-v3": { perSecond: 0.1 } }),
    CREATOR_GLOBAL_MAX_GENERATIONS_PER_DAY: "1", CREATOR_GLOBAL_MAX_COST_PER_DAY: "1", CREATOR_WORKSPACE_MAX_GENERATIONS_PER_DAY: "1",
    CREATOR_WORKSPACE_MAX_COST_PER_DAY: "1", CREATOR_USER_MAX_GENERATIONS_PER_DAY: "1", CREATOR_USER_MAX_COST_PER_DAY: "1",
    CREATOR_PAID_SPEECH_USERS: "speaker", CREATOR_PAID_AVATAR_USERS: "presenter", CREATOR_PAID_VIDEO_USERS: "videographer",
  };
  const config = (readCreatorPaidConfig(env) as { ok: true; config: Parameters<typeof estimateCreatorCost>[0] }).config;

  it("prices speech per thousand characters and avatar per (rounded-up) second of driving audio", () => {
    expect(estimateCreatorCost(config, "bulbul:v3", { kind: "SPEECH", prompt: "அ".repeat(2000) })).toBe(1);
    expect(estimateCreatorCost(config, "heygen-v3", { kind: "AVATAR_VIDEO", prompt: "t", avatarId: "a_bcd", consentId: 1, audioAssetId: 1, expectedSeconds: 12.2 })).toBeCloseTo(1.3, 6);
    expect(estimateCreatorCost(config, "heygen-v3", { kind: "AVATAR_VIDEO", prompt: "t", avatarId: "a_bcd", consentId: 1, audioAssetId: 1, expectedSeconds: 0 })).toBeUndefined();
    expect(estimateCreatorCost(config, "bulbul:v3", { kind: "IMAGE", prompt: "x" })).toBeUndefined(); // a per-character price never budgets an image
  });

  it("keeps every kind on its own allowlist", () => {
    expect(paidKindOf("SPEECH")).toBe("SPEECH");
    expect(paidKindOf("AVATAR_VIDEO")).toBe("AVATAR_VIDEO");
    expect(isAuthorizedForPaidKind({ openId: "speaker" }, "SPEECH", config)).toBe(true);
    expect(isAuthorizedForPaidKind({ openId: "speaker" }, "AVATAR_VIDEO", config)).toBe(false);
    expect(isAuthorizedForPaidKind({ openId: "videographer" }, "AVATAR_VIDEO", config)).toBe(false);
    expect(isAuthorizedForPaidKind({ openId: "presenter" }, "AVATAR_VIDEO", config)).toBe(true);
  });

  it("persists speech as an AUDIO asset (wav) and avatar output as VIDEO", () => {
    expect(assetTypeForGeneration("SPEECH")).toBe("AUDIO");
    expect(assetTypeForGeneration("AVATAR_VIDEO")).toBe("VIDEO");
    expect(extensionForCreatorMimeType("audio/wav")).toBe("wav");
  });
});
