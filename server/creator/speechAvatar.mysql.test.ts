import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { createTestDatabase, migrationStatements, skipMysqlSuite, type TestDatabase } from "../testing/mysqlTestDb";

/**
 * Real SQL for migration 0016 and the speech/avatar wiring: enum upgrade over existing rows, consent store, approved
 * audio resolution, and one SPEECH generation through the real orchestrator + persistence (provider HTTP is faked).
 */
const holder = vi.hoisted(() => ({ db: undefined as unknown, objects: new Map<string, Buffer>() }));
vi.mock("../db", async importOriginal => ({ ...(await importOriginal<typeof import("../db")>()), getDb: async () => holder.db }));
vi.mock("../storage", async importOriginal => ({
  ...(await importOriginal<typeof import("../storage")>()),
  storagePut: async (key: string, data: Buffer | Uint8Array) => { holder.objects.set(key, Buffer.from(data)); return { key, url: `/s/${key}` }; },
  storageRead: async (key: string) => { const v = holder.objects.get(key); if (!v) throw new Error("missing"); return new Uint8Array(v); },
}));

import { findActiveConsent, recordConsent, revokeConsent } from "./speech/consentStore";
import { resolveAvatarAudio } from "./speech/audioAsset";
import { makePcmWav } from "./speech/wav";
import { pollCreatorGeneration, submitCreatorGeneration, type CreatorSpendHook } from "./orchestrator";
import { reviewGeneratedSpeech } from "./speech/speechReview";

describe.skipIf(skipMysqlSuite())("migration 0016 and speech/avatar wiring (real SQL)", { timeout: 60_000 }, () => {
  let database: TestDatabase;
  const run = (statement: ReturnType<typeof sql>) => database.db.execute(statement);
  const rows = async <T>(statement: ReturnType<typeof sql>) => ((await database.db.execute(statement)) as unknown as [T[]])[0];

  beforeAll(async () => { database = await createTestDatabase(); holder.db = database.db; });
  afterAll(async () => { await database?.close(); });
  beforeEach(() => holder.objects.clear());

  it("upgrades a 0015 database: existing generation kinds are preserved, the new kinds become insertable, unknown kinds are refused", async () => {
    const scratch = await createTestDatabase({ migrate: false });
    try {
      const q = (s: string) => scratch.pool.promise().query(s);
      await q("SET SESSION sql_mode = 'STRICT_ALL_TABLES'");
      const all = migrationStatements();
      const upTo = all.findIndex(m => m.tag === "0015_artifact_file_references");
      for (const m of all.slice(0, upTo + 1)) for (const s of m.statements) await q(s);
      await q("INSERT INTO creatorGenerations (workspaceId, creatorProjectId, shotId, idempotencyKey, kind, provider, model, parametersJson) VALUES (1,1,1,'a','IMAGE','google-image','m','{}'),(1,1,1,'b','VIDEO_EXTENSION','google-veo','m','{}')");
      await expect(q("INSERT INTO creatorGenerations (workspaceId, creatorProjectId, shotId, idempotencyKey, kind, provider, model, parametersJson) VALUES (1,1,1,'c','SPEECH','sarvam-tts','m','{}')")).rejects.toThrow();
      for (const s of all[upTo + 1].statements) await q(s);
      expect(all[upTo + 1].tag).toBe("0016_creator_speech_avatar_consent");
      const [kinds] = await q("SELECT idempotencyKey, kind FROM creatorGenerations ORDER BY idempotencyKey") as unknown as [Array<{ idempotencyKey: string; kind: string }>];
      expect(kinds).toEqual([{ idempotencyKey: "a", kind: "IMAGE" }, { idempotencyKey: "b", kind: "VIDEO_EXTENSION" }]);
      await q("INSERT INTO creatorGenerations (workspaceId, creatorProjectId, shotId, idempotencyKey, kind, provider, model, parametersJson) VALUES (1,1,1,'c','SPEECH','sarvam-tts','m','{}'),(1,1,1,'d','AVATAR_VIDEO','heygen-avatar','m','{}')");
      await expect(q("INSERT INTO creatorGenerations (workspaceId, creatorProjectId, shotId, idempotencyKey, kind, provider, model, parametersJson) VALUES (1,1,1,'e','BOGUS','x','m','{}')")).rejects.toThrow();
      await q("INSERT INTO creatorReviews (workspaceId, creatorProjectId, reviewType, decision) VALUES (1, 1, 'HUMAN_SPEECH', 'PASS')");
      await expect(q("INSERT INTO creatorReviews (workspaceId, creatorProjectId, reviewType, decision) VALUES (1, 1, 'BOGUS', 'PASS')")).rejects.toThrow();
      const [[{ n }]] = await q("SELECT COUNT(*) AS n FROM creatorConsents") as unknown as [[{ n: number }]];
      expect(Number(n)).toBe(0);
    } finally { await scratch.close(); }
  });

  it("consent store: active lookup is workspace-, purpose- and subject-bound; revocation is permanent", async () => {
    const { consentId } = await recordConsent({ workspaceId: 7, userId: 1, purpose: "avatar_video", provider: "heygen-avatar", providerSubjectId: "avatar_ok_01", evidenceReference: "release-2026-11-001" });
    const want = { consentId, purpose: "avatar_video" as const, provider: "heygen-avatar", providerSubjectId: "avatar_ok_01" };
    expect((await findActiveConsent({ ...want, workspaceId: 7 })).id).toBe(consentId);
    await expect(findActiveConsent({ ...want, workspaceId: 8 })).rejects.toThrow("CREATOR_CONSENT_NOT_FOUND");
    await expect(findActiveConsent({ ...want, workspaceId: 7, providerSubjectId: "avatar_other_1" })).rejects.toThrow("CREATOR_CONSENT_SUBJECT_MISMATCH");
    await expect(revokeConsent({ workspaceId: 8, userId: 2, consentId })).rejects.toThrow("CREATOR_CONSENT_NOT_FOUND_OR_REVOKED");
    await revokeConsent({ workspaceId: 7, userId: 1, consentId });
    await expect(findActiveConsent({ ...want, workspaceId: 7 })).rejects.toThrow("CREATOR_CONSENT_REVOKED");
    await expect(revokeConsent({ workspaceId: 7, userId: 1, consentId })).rejects.toThrow("CREATOR_CONSENT_NOT_FOUND_OR_REVOKED");
    await expect(recordConsent({ workspaceId: 7, userId: 1, purpose: "avatar_video", provider: "heygen-avatar", providerSubjectId: "avatar_ok_01", evidenceReference: "release-x", validUntil: new Date(Date.now() - 1000) })).rejects.toThrow("CREATOR_CONSENT_VALID_UNTIL_PAST");
  });

  it("speech review refuses assets that are not generated speech of this workspace and project", async () => {
    await run(sql`INSERT INTO creatorAssets (workspaceId, creatorProjectId, assetType, mimeType, storageKey, checksumSha256, byteSize, immutable, provenanceJson, reviewDecision) VALUES
      (7, 1, 'AUDIO', 'audio/wav', 'audio/uploaded.wav', ${"c".repeat(64)}, 10, 0, '{"source":"upload"}', 'PENDING'),
      (7, 1, 'IMAGE', 'image/png', 'img/x.png', ${"d".repeat(64)}, 10, 0, '{"generationId":1,"parameters":{"kind":"SPEECH","prompt":"x","languageCode":"ta-IN"}}', 'PENDING')`);
    const ids = await rows<{ id: number; storageKey: string }>(sql`SELECT id, storageKey FROM creatorAssets WHERE storageKey IN ('audio/uploaded.wav','img/x.png')`);
    const review = (assetId: number, workspaceId = 7) => reviewGeneratedSpeech({ workspaceId, creatorProjectId: 1, assetId, reviewerUserId: 1, decision: "PASS", notes: "n" });
    await expect(review(ids.find(r => r.storageKey === "audio/uploaded.wav")!.id)).rejects.toThrow("CREATOR_SPEECH_REVIEW_NOT_GENERATED_SPEECH");
    await expect(review(ids.find(r => r.storageKey === "img/x.png")!.id)).rejects.toThrow("CREATOR_SPEECH_REVIEW_NOT_GENERATED_SPEECH");
    await expect(review(ids.find(r => r.storageKey === "audio/uploaded.wav")!.id, 8)).rejects.toThrow("CREATOR_SPEECH_REVIEW_ASSET_NOT_FOUND");
  });

  it("approved-audio resolution reads only an approved immutable WAV of the same workspace and project", async () => {
    const wav = makePcmWav(2400);
    holder.objects.set("audio/master.wav", wav);
    holder.objects.set("audio/pending.wav", wav);
    await run(sql`INSERT INTO creatorAssets (workspaceId, creatorProjectId, assetType, mimeType, storageKey, checksumSha256, byteSize, immutable, provenanceJson, reviewDecision) VALUES
      (7, 1, 'AUDIO_MASTER', 'audio/wav', 'audio/master.wav', ${"a".repeat(64)}, ${wav.length}, 1, '{}', 'APPROVED'),
      (7, 1, 'AUDIO', 'audio/wav', 'audio/pending.wav', ${"b".repeat(64)}, ${wav.length}, 0, '{}', 'PENDING')`);
    const ids = await rows<{ id: number; storageKey: string }>(sql`SELECT id, storageKey FROM creatorAssets WHERE storageKey IN ('audio/master.wav','audio/pending.wav') ORDER BY id`);
    const master = ids.find(r => r.storageKey === "audio/master.wav")!.id;
    const pending = ids.find(r => r.storageKey === "audio/pending.wav")!.id;
    expect(await resolveAvatarAudio({ workspaceId: 7, creatorProjectId: 1, assetId: master })).toMatchObject({ assetId: master, durationMs: 2400, mimeType: "audio/wav" });
    await expect(resolveAvatarAudio({ workspaceId: 7, creatorProjectId: 1, assetId: pending })).rejects.toThrow("CREATOR_AVATAR_AUDIO_MUTABLE");
    await expect(resolveAvatarAudio({ workspaceId: 8, creatorProjectId: 1, assetId: master })).rejects.toThrow("CREATOR_AVATAR_AUDIO_NOT_FOUND");
    await expect(resolveAvatarAudio({ workspaceId: 7, creatorProjectId: 2, assetId: master })).rejects.toThrow("CREATOR_AVATAR_AUDIO_NOT_FOUND");
  });

  it("one SPEECH generation runs through the real orchestrator and persistence: staged once, persisted as an AUDIO asset, replay never re-bills", async () => {
    vi.stubEnv("CREATOR_TTS_SARVAM_API_KEY", "test-only-key");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ request_id: "r1", audios: [makePcmWav(1500).toString("base64")] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await run(sql`INSERT INTO creatorProjects (workspaceId, name) VALUES (7, 'speech-e2e')`);
      const [{ id: projectId }] = await rows<{ id: number }>(sql`SELECT id FROM creatorProjects WHERE name = 'speech-e2e'`);
      await run(sql`INSERT INTO creatorScenes (workspaceId, creatorProjectId, sceneIndex, title) VALUES (7, ${projectId}, 0, 's')`);
      const [{ id: sceneId }] = await rows<{ id: number }>(sql`SELECT id FROM creatorScenes WHERE creatorProjectId = ${projectId}`);
      await run(sql`INSERT INTO creatorShots (workspaceId, creatorProjectId, sceneId, shotIndex, title) VALUES (7, ${projectId}, ${sceneId}, 0, 'line 1')`);
      const [{ id: shotId }] = await rows<{ id: number }>(sql`SELECT id FROM creatorShots WHERE creatorProjectId = ${projectId}`);

      const events: string[] = [];
      const spend: CreatorSpendHook = {
        price: () => { events.push("price"); },
        reserve: async () => { events.push("reserve"); return { created: true }; },
        commit: async () => { events.push("commit"); },
        release: async () => { events.push("release"); },
        markUnknown: async () => { events.push("unknown"); },
      };
      const idempotencyKey = randomUUID();
      const input = { workspaceId: 7, creatorProjectId: projectId, shotId, idempotencyKey, spend, request: { kind: "SPEECH" as const, prompt: "முருகா வேல் வேல்", languageCode: "ta-IN" as const } };
      const submitted = await submitCreatorGeneration(input);
      expect(submitted).toMatchObject({ provider: "sarvam-tts", state: "RUNNING", reused: false });
      expect(events).toEqual(["price", "reserve", "commit"]);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const polled = await pollCreatorGeneration({ workspaceId: 7, generationId: submitted.generationId });
      expect(polled).toMatchObject({ state: "SUCCEEDED", outputAssetId: expect.any(Number) });
      const [asset] = await rows<{ assetType: string; mimeType: string; reviewDecision: string; immutable: number; provenanceJson: string }>(sql`SELECT assetType, mimeType, reviewDecision, immutable, provenanceJson FROM creatorAssets WHERE id = ${polled.outputAssetId}`);
      expect(asset).toMatchObject({ assetType: "AUDIO", mimeType: "audio/wav", reviewDecision: "PENDING", immutable: 0 });
      const provenance = JSON.parse(asset.provenanceJson);
      expect(provenance.parameters).toMatchObject({ kind: "SPEECH", prompt: "முருகா வேல் வேல்", languageCode: "ta-IN" });
      expect(provenance.providerJobId).toMatch(/^creator\/staging\/speech\/[0-9a-f-]{36}\.wav$/);

      const replay = await submitCreatorGeneration({ ...input, idempotencyKey });
      expect(replay).toMatchObject({ reused: true, state: "SUCCEEDED", outputAssetId: polled.outputAssetId });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [{ n }] = await rows<{ n: number }>(sql`SELECT COUNT(*) AS n FROM creatorGenerations WHERE idempotencyKey = ${idempotencyKey}`);
      expect(Number(n)).toBe(1);

      // Before human review the generated speech cannot drive an avatar.
      await expect(resolveAvatarAudio({ workspaceId: 7, creatorProjectId: projectId, assetId: polled.outputAssetId! })).rejects.toThrow("CREATOR_AVATAR_AUDIO_MUTABLE");
      // Concurrent reviews: exactly one wins.
      const outcomes = await Promise.allSettled([
        reviewGeneratedSpeech({ workspaceId: 7, creatorProjectId: projectId, assetId: polled.outputAssetId!, reviewerUserId: 1, decision: "PASS", notes: "Listened: words and pronunciation match the approved Tamil." }),
        reviewGeneratedSpeech({ workspaceId: 7, creatorProjectId: projectId, assetId: polled.outputAssetId!, reviewerUserId: 1, decision: "REJECT", notes: "duplicate click" }),
      ]);
      expect(outcomes.filter(o => o.status === "fulfilled")).toHaveLength(1);
      expect((outcomes.find(o => o.status === "rejected") as PromiseRejectedResult).reason.message).toBe("CREATOR_SPEECH_REVIEW_ALREADY_FINAL");
      const winner = (outcomes.find(o => o.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof reviewGeneratedSpeech>>>).value;
      const reviews = await rows<{ reviewType: string; decision: string; scoresJson: string }>(sql`SELECT reviewType, decision, scoresJson FROM creatorReviews WHERE assetId = ${polled.outputAssetId}`);
      expect(reviews).toHaveLength(1);
      expect(reviews[0]).toMatchObject({ reviewType: "HUMAN_SPEECH", decision: winner.decision });
      expect(JSON.parse(reviews[0].scoresJson)).toMatchObject({ languageCode: "ta-IN", approvedChecksumSha256: winner.checksumSha256 });
      if (winner.decision === "PASS") {
        expect(await resolveAvatarAudio({ workspaceId: 7, creatorProjectId: projectId, assetId: polled.outputAssetId! })).toMatchObject({ durationMs: 1500 });
      } else {
        await expect(resolveAvatarAudio({ workspaceId: 7, creatorProjectId: projectId, assetId: polled.outputAssetId! })).rejects.toThrow();
      }
      await expect(reviewGeneratedSpeech({ workspaceId: 7, creatorProjectId: projectId, assetId: polled.outputAssetId!, reviewerUserId: 1, decision: "PASS", notes: "again" })).rejects.toThrow("CREATOR_SPEECH_REVIEW_ALREADY_FINAL");
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });
});
