import { randomUUID } from "node:crypto";
import { storagePut, storageRead } from "../../storage";
import type {
  CreatorFailureClass,
  CreatorFetchedArtifact,
  CreatorMediaProvider,
  CreatorMediaRequest,
  CreatorProviderArtifact,
  CreatorProviderPoll,
  CreatorProviderSubmission,
} from "../types";
import { downloadAvatarVideo, pollAvatarVideo, submitAvatarVideo, uploadAvatarAudio, type HeygenDeps } from "./heygenAvatar";
import { synthesizeSarvamSpeech, SARVAM_TTS_MODELS, type SarvamTtsDeps, type SarvamTtsModel } from "./sarvamTts";
import { SpeechProviderError } from "./types";
import { parseWav } from "./wav";

/**
 * Speech and avatar providers behind the existing CreatorMediaProvider seam, so they inherit the orchestrator's durable
 * generation rows, idempotency, spend holds, ambiguous-submission handling, retry and artifact persistence unchanged.
 */
function classify(error: unknown): CreatorFailureClass {
  if (error instanceof SpeechProviderError) return error.failureClass === "CANCELLED" ? "UNKNOWN" : error.failureClass;
  return "UNKNOWN";
}

export const SPEECH_STAGING_PREFIX = "creator/staging/speech/";
const STAGING_KEY = /^creator\/staging\/speech\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.wav$/;

export type SpeechProviderDeps = {
  synthesize?: typeof synthesizeSarvamSpeech;
  sarvam?: SarvamTtsDeps;
  put?: (key: string, data: Buffer, contentType: string) => Promise<{ key: string }>;
  read?: (key: string) => Promise<Uint8Array>;
  apiKeyPresent?: () => boolean;
};

/**
 * Sarvam TTS is synchronous. submit() synthesises, writes the WAV to a random, provider-private staging key and returns
 * that key as the provider job id, so the billed audio survives a crash between submit and persistence and is never
 * synthesised (billed) twice for one generation. poll() reports it; fetchArtifact() reads only that staging prefix.
 */
export function createSarvamSpeechProvider(deps: SpeechProviderDeps = {}): CreatorMediaProvider {
  const synthesize = deps.synthesize ?? synthesizeSarvamSpeech;
  // Resolved at call time (not import time) so modules that mock storage partially still load this registry.
  const put = (key: string, data: Buffer, type: string) => (deps.put ?? storagePut)(key, data, type);
  const read = (key: string) => (deps.read ?? storageRead)(key);
  const configured = deps.apiKeyPresent ?? (() => Boolean(process.env.CREATOR_TTS_SARVAM_API_KEY?.trim()));
  return {
    id: "sarvam-tts",
    status: () => ({ provider: "sarvam-tts", configured: configured(), defaultModel: "bulbul:v3", capabilities: { textToSpeech: true } }),
    supports: (request: CreatorMediaRequest) => request.kind === "SPEECH",
    async submit(request: CreatorMediaRequest): Promise<CreatorProviderSubmission> {
      if (request.kind !== "SPEECH") throw new SpeechProviderError("SPEECH_REQUEST_KIND_INVALID", "INVALID_REQUEST", false);
      const model = (request.model ?? "bulbul:v3") as SarvamTtsModel;
      if (!SARVAM_TTS_MODELS.includes(model)) throw new SpeechProviderError("SPEECH_MODEL_UNSUPPORTED", "INVALID_REQUEST", false);
      const result = await synthesize({ text: request.prompt, model, languageCode: request.languageCode ?? "ta-IN", speaker: request.speaker, pace: request.pace }, {}, deps.sarvam);
      const key = `${SPEECH_STAGING_PREFIX}${randomUUID()}.wav`;
      await put(key, result.wav, "audio/wav");
      return {
        providerJobId: key,
        state: "SUCCEEDED",
        provider: "sarvam-tts",
        model: result.model,
        raw: { providerRequestIds: result.providerRequestIds, durationMs: result.durationMs, sha256: result.sha256, chunkCount: result.chunkCount, characters: result.characters },
      };
    },
    async poll(providerJobId: string): Promise<CreatorProviderPoll> {
      if (!STAGING_KEY.test(providerJobId)) throw new SpeechProviderError("SPEECH_STAGING_KEY_INVALID", "ARTIFACT", false);
      return { providerJobId, state: "SUCCEEDED", raw: { staged: true }, artifacts: [{ mimeType: "audio/wav", uri: providerJobId }] };
    },
    async fetchArtifact(artifact: CreatorProviderArtifact): Promise<CreatorFetchedArtifact> {
      if (!artifact.uri || !STAGING_KEY.test(artifact.uri)) throw new SpeechProviderError("SPEECH_STAGING_KEY_INVALID", "ARTIFACT", false);
      const data = Buffer.from(await read(artifact.uri));
      parseWav(data);
      return { mimeType: "audio/wav", data: new Uint8Array(data) };
    },
    classifyFailure: classify,
  };
}

export type AvatarProviderDeps = { heygen?: HeygenDeps; apiKeyPresent?: () => boolean };

/**
 * HeyGen avatar video. Asynchronous: submit uploads the server-resolved audio and creates the render; poll maps status;
 * fetchArtifact downloads from an allowlisted host. No cancel method: HeyGen documents no in-flight cancel, so the
 * existing orchestrator refuses cancellation instead of pretending (CREATOR_PROVIDER_CANCEL_UNSUPPORTED).
 */
export function createHeygenAvatarProvider(deps: AvatarProviderDeps = {}): CreatorMediaProvider {
  const configured = deps.apiKeyPresent ?? (() => Boolean(process.env.CREATOR_AVATAR_HEYGEN_API_KEY?.trim()));
  return {
    id: "heygen-avatar",
    status: () => ({ provider: "heygen-avatar", configured: configured(), defaultModel: "heygen-v2", capabilities: { avatarVideo: true } }),
    supports: (request: CreatorMediaRequest) => request.kind === "AVATAR_VIDEO",
    async submit(request: CreatorMediaRequest): Promise<CreatorProviderSubmission> {
      if (request.kind !== "AVATAR_VIDEO") throw new SpeechProviderError("AVATAR_REQUEST_KIND_INVALID", "INVALID_REQUEST", false);
      if (!request.audio) throw new SpeechProviderError("AVATAR_AUDIO_NOT_RESOLVED", "INVALID_REQUEST", false);
      const { assetId } = await uploadAvatarAudio(Buffer.from(request.audio.data), request.audio.mimeType, {}, deps.heygen);
      const callbackId = request.callbackId ?? `creator-${randomUUID()}`;
      const { videoId, testMode } = await submitAvatarVideo({ avatarId: request.avatarId, audioAssetId: assetId, callbackId, live: request.live, title: request.prompt }, {}, deps.heygen);
      return { providerJobId: videoId, state: "SUBMITTED", provider: "heygen-avatar", model: request.model ?? "heygen-v2", raw: { uploadedAudioAssetId: assetId, testMode, callbackId } };
    },
    async poll(providerJobId: string): Promise<CreatorProviderPoll> {
      const poll = await pollAvatarVideo(providerJobId, {}, deps.heygen);
      if (poll.state === "SUCCEEDED") return { providerJobId, state: "SUCCEEDED", raw: { status: poll.providerStatus, durationSeconds: poll.durationSeconds }, artifacts: [{ mimeType: "video/mp4", uri: poll.videoUrl }] };
      if (poll.state === "FAILED") return { providerJobId, state: "FAILED", raw: { status: poll.providerStatus }, artifacts: [], failureClass: "UNKNOWN", errorMessage: poll.errorMessage };
      return { providerJobId, state: "RUNNING", raw: { status: poll.providerStatus }, artifacts: [] };
    },
    async fetchArtifact(artifact: CreatorProviderArtifact): Promise<CreatorFetchedArtifact> {
      if (!artifact.uri) throw new SpeechProviderError("AVATAR_ARTIFACT_URI_MISSING", "ARTIFACT", false);
      const file = await downloadAvatarVideo(artifact.uri, {}, deps.heygen);
      return { mimeType: file.mimeType, data: new Uint8Array(file.data) };
    },
    classifyFailure: classify,
  };
}

export const sarvamSpeechProvider = createSarvamSpeechProvider();
export const heygenAvatarProvider = createHeygenAvatarProvider();
