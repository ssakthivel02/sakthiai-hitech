import { createHash } from "node:crypto";
import { callSignal, classifyHttpStatus, SpeechProviderError, toSpeechError, type CallControl, type FetchLike } from "./types";

/**
 * HeyGen avatar-video adapter (approved-audio -> talking avatar). Contract source: docs.heygen.com (v2):
 *   POST https://upload.heygen.com/v1/asset              raw audio bytes, Content-Type = MIME  -> { code:100, data:{ id } }
 *   POST https://api.heygen.com/v2/video/generate         voice: { type:"audio", audio_asset_id }  -> { data:{ video_id } }
 *   GET  https://api.heygen.com/v1/video_status.get       ?video_id=  -> { data:{ status, video_url, duration, error } }
 *
 * STATUS: CONTRACT_TESTED against documented shapes only; NO live call has been made from this repository.
 * HeyGen's documentation now presents a /v3 API ("formerly v2/video/generate"); endpoints are isolated in
 * HEYGEN_ENDPOINTS so a v3 move is a contained change, to be confirmed at the first owner-approved live call.
 *
 * CANCELLATION: no provider-side cancel endpoint is documented for in-flight renders (only permanent delete).
 * Aborting therefore stops polling and returns the provider video id for reconciliation; provider-side work and cost
 * may still complete. That is reported as `providerCancelSupported: false`, never as a successful cancel.
 *
 * COST CONTROL: `test: true` (watermarked, free) is the default. A live render requires `live: true`, which the
 * caller may set only after authorizeSpeechAvatar() has allowed the spend.
 */
export const HEYGEN_ENDPOINTS = {
  upload: "https://upload.heygen.com/v1/asset",
  generate: "https://api.heygen.com/v2/video/generate",
  status: "https://api.heygen.com/v1/video_status.get",
} as const;

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 10_000;
const DEFAULT_MAX_WAIT_MS = 20 * 60_000;
const MAX_VIDEO_BYTES = 512 * 1024 * 1024;
const DEFAULT_DOWNLOAD_HOST_SUFFIXES = [".heygen.ai", ".heygen.com"];

export type HeygenDeps = {
  fetch?: FetchLike;
  /** Defaults to CREATOR_AVATAR_HEYGEN_API_KEY. */
  apiKey?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  maxWaitMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Hostname suffixes the finished video may be downloaded from; default from CREATOR_AVATAR_DOWNLOAD_HOSTS. */
  downloadHostSuffixes?: readonly string[];
};

function key(deps: HeygenDeps): string {
  const apiKey = (deps.apiKey ?? process.env.CREATOR_AVATAR_HEYGEN_API_KEY ?? "").trim();
  if (!apiKey) throw new SpeechProviderError("AVATAR_PROVIDER_NOT_CONFIGURED", "AUTH", false);
  return apiKey;
}

async function failFromResponse(response: Response): Promise<never> {
  const { failureClass, retryable } = classifyHttpStatus(response.status);
  await response.arrayBuffer().catch(() => undefined);
  throw new SpeechProviderError(`AVATAR_PROVIDER_HTTP_${response.status}`, failureClass, retryable, response.status);
}

function idOf(value: unknown, code: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{4,128}$/.test(value)) throw new SpeechProviderError(code, "ARTIFACT", true);
  return value;
}

export async function uploadAvatarAudio(audio: Buffer, contentType: "audio/wav" | "audio/mpeg", control: CallControl = {}, deps: HeygenDeps = {}): Promise<{ assetId: string }> {
  if (!audio.length) throw new SpeechProviderError("AVATAR_AUDIO_EMPTY", "INVALID_REQUEST", false);
  const doFetch = deps.fetch ?? fetch;
  try {
    const response = await doFetch(HEYGEN_ENDPOINTS.upload, {
      method: "POST",
      headers: { "x-api-key": key(deps), "content-type": contentType },
      body: new Uint8Array(audio),
      redirect: "error",
      signal: callSignal(control.signal, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    if (!response.ok) await failFromResponse(response);
    const payload = (await response.json()) as { code?: number; data?: { id?: unknown } };
    if (payload.code !== undefined && payload.code !== 100) throw new SpeechProviderError("AVATAR_UPLOAD_REJECTED", "INVALID_REQUEST", false);
    return { assetId: idOf(payload.data?.id, "AVATAR_UPLOAD_ASSET_ID_MISSING") };
  } catch (error) {
    throw toSpeechError(error, control);
  }
}

export type AvatarSubmitRequest = {
  avatarId: string;
  audioAssetId: string;
  width?: number;
  height?: number;
  title?: string;
  /** Our idempotency key, echoed by the provider so an unknown submission can be reconciled. */
  callbackId: string;
  /** Default false: provider test mode (free, watermarked). */
  live?: boolean;
};

export function buildAvatarGeneratePayload(request: AvatarSubmitRequest) {
  idOf(request.avatarId, "AVATAR_ID_INVALID");
  idOf(request.audioAssetId, "AVATAR_AUDIO_ASSET_INVALID");
  if (!/^[A-Za-z0-9_.:-]{8,128}$/.test(request.callbackId)) throw new SpeechProviderError("AVATAR_CALLBACK_ID_INVALID", "INVALID_REQUEST", false);
  const width = request.width ?? 1920;
  const height = request.height ?? 1080;
  if (![width, height].every(value => Number.isInteger(value) && value >= 360 && value <= 4096)) throw new SpeechProviderError("AVATAR_DIMENSION_INVALID", "INVALID_REQUEST", false);
  return {
    test: request.live !== true,
    caption: false,
    title: (request.title ?? "SakthiAI avatar video").slice(0, 120),
    callback_id: request.callbackId,
    dimension: { width, height },
    video_inputs: [{
      character: { type: "avatar", avatar_id: request.avatarId, avatar_style: "normal" },
      voice: { type: "audio", audio_asset_id: request.audioAssetId },
    }],
  };
}

export async function submitAvatarVideo(request: AvatarSubmitRequest, control: CallControl = {}, deps: HeygenDeps = {}): Promise<{ videoId: string; testMode: boolean }> {
  const body = buildAvatarGeneratePayload(request);
  if (control.signal?.aborted) throw new SpeechProviderError("SPEECH_CANCELLED", "CANCELLED", false);
  const doFetch = deps.fetch ?? fetch;
  try {
    const response = await doFetch(HEYGEN_ENDPOINTS.generate, {
      method: "POST",
      headers: { "x-api-key": key(deps), "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      signal: callSignal(control.signal, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    if (!response.ok) await failFromResponse(response);
    const payload = (await response.json()) as { data?: { video_id?: unknown }; error?: unknown };
    return { videoId: idOf(payload.data?.video_id, "AVATAR_SUBMIT_VIDEO_ID_MISSING"), testMode: body.test };
  } catch (error) {
    const mapped = toSpeechError(error, control);
    // A network/timeout failure AFTER the request may have reached the provider: the submission is ambiguous.
    throw mapped;
  }
}

export type AvatarPoll = {
  state: "RUNNING" | "SUCCEEDED" | "FAILED";
  providerStatus: string;
  videoUrl?: string;
  durationSeconds?: number;
  errorMessage?: string;
};

export function mapAvatarStatus(payload: unknown): AvatarPoll {
  const data = (payload as { data?: { status?: unknown; video_url?: unknown; duration?: unknown; error?: unknown } } | null)?.data;
  const status = typeof data?.status === "string" ? data.status : "";
  if (status === "completed") {
    if (typeof data?.video_url !== "string" || !data.video_url) return { state: "FAILED", providerStatus: status, errorMessage: "AVATAR_OUTPUT_URL_MISSING" };
    return { state: "SUCCEEDED", providerStatus: status, videoUrl: data.video_url, durationSeconds: typeof data.duration === "number" ? data.duration : undefined };
  }
  if (status === "failed") return { state: "FAILED", providerStatus: status, errorMessage: "AVATAR_PROVIDER_RENDER_FAILED" };
  if (status === "pending" || status === "processing" || status === "waiting") return { state: "RUNNING", providerStatus: status };
  throw new SpeechProviderError("AVATAR_STATUS_UNRECOGNIZED", "UNKNOWN", true);
}

export async function pollAvatarVideo(videoId: string, control: CallControl = {}, deps: HeygenDeps = {}): Promise<AvatarPoll> {
  idOf(videoId, "AVATAR_VIDEO_ID_INVALID");
  const doFetch = deps.fetch ?? fetch;
  try {
    const response = await doFetch(`${HEYGEN_ENDPOINTS.status}?video_id=${encodeURIComponent(videoId)}`, {
      method: "GET",
      headers: { "x-api-key": key(deps), accept: "application/json" },
      redirect: "error",
      signal: callSignal(control.signal, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    if (!response.ok) await failFromResponse(response);
    return mapAvatarStatus(await response.json());
  } catch (error) {
    throw toSpeechError(error, control);
  }
}

function downloadSuffixes(deps: HeygenDeps): readonly string[] {
  if (deps.downloadHostSuffixes) return deps.downloadHostSuffixes;
  const configured = (process.env.CREATOR_AVATAR_DOWNLOAD_HOSTS ?? "").split(",").map(entry => entry.trim().toLowerCase()).filter(Boolean);
  return configured.length ? configured : DEFAULT_DOWNLOAD_HOST_SUFFIXES;
}

/** Fetch the finished video: https only, host allowlisted, no redirects, size-capped. */
export async function downloadAvatarVideo(videoUrl: string, control: CallControl = {}, deps: HeygenDeps = {}): Promise<{ data: Buffer; sha256: string; mimeType: "video/mp4" }> {
  let url: URL;
  try { url = new URL(videoUrl); } catch { throw new SpeechProviderError("AVATAR_DOWNLOAD_URL_INVALID", "ARTIFACT", false); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || !downloadSuffixes(deps).some(suffix => host.endsWith(suffix))) {
    throw new SpeechProviderError("AVATAR_DOWNLOAD_HOST_NOT_ALLOWED", "ARTIFACT", false);
  }
  const doFetch = deps.fetch ?? fetch;
  try {
    const response = await doFetch(url.toString(), { method: "GET", redirect: "error", signal: callSignal(control.signal, 5 * 60_000) });
    if (!response.ok) await failFromResponse(response);
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > MAX_VIDEO_BYTES) throw new SpeechProviderError("AVATAR_DOWNLOAD_TOO_LARGE", "ARTIFACT", false);
    const data = Buffer.from(await response.arrayBuffer());
    if (!data.length) throw new SpeechProviderError("AVATAR_DOWNLOAD_EMPTY", "ARTIFACT", true);
    if (data.length > MAX_VIDEO_BYTES) throw new SpeechProviderError("AVATAR_DOWNLOAD_TOO_LARGE", "ARTIFACT", false);
    // ISO-BMFF: "ftyp" at offset 4. Refuse anything that is not an MP4 container.
    if (data.length < 12 || data.toString("ascii", 4, 8) !== "ftyp") throw new SpeechProviderError("AVATAR_DOWNLOAD_NOT_MP4", "ARTIFACT", false);
    return { data, sha256: createHash("sha256").update(data).digest("hex"), mimeType: "video/mp4" };
  } catch (error) {
    throw toSpeechError(error, control);
  }
}

const defaultSleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) return reject(new SpeechProviderError("SPEECH_CANCELLED", "CANCELLED", false));
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new SpeechProviderError("SPEECH_CANCELLED", "CANCELLED", false)); }, { once: true });
});

export type AvatarRunResult =
  | { state: "SUCCEEDED"; videoId: string; testMode: boolean; video: Buffer; sha256: string; durationSeconds?: number }
  | { state: "CANCELLED_LOCAL"; videoId?: string; providerCancelSupported: false; note: string };

/**
 * Upload -> submit -> poll -> download. `onProviderJob` fires as soon as the provider job id exists and BEFORE
 * polling, so the caller can persist it durably: after a crash the paid job is reconciled, not re-submitted.
 */
export async function runAvatarVideo(
  input: { audio: Buffer; audioContentType: "audio/wav" | "audio/mpeg"; avatarId: string; callbackId: string; live?: boolean; width?: number; height?: number; title?: string },
  control: CallControl & { onProviderJob?: (job: { videoId: string; testMode: boolean }) => void | Promise<void> } = {},
  deps: HeygenDeps = {},
): Promise<AvatarRunResult> {
  const sleep = deps.sleep ?? defaultSleep;
  const interval = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const deadline = Date.now() + (deps.maxWaitMs ?? DEFAULT_MAX_WAIT_MS);
  let videoId: string | undefined;
  try {
    control.onProgress?.({ stage: "upload-audio", completed: 0, total: 4 });
    const { assetId } = await uploadAvatarAudio(input.audio, input.audioContentType, control, deps);
    control.onProgress?.({ stage: "submit", completed: 1, total: 4 });
    const submitted = await submitAvatarVideo({ avatarId: input.avatarId, audioAssetId: assetId, callbackId: input.callbackId, live: input.live, width: input.width, height: input.height, title: input.title }, control, deps);
    videoId = submitted.videoId;
    await control.onProviderJob?.({ videoId, testMode: submitted.testMode });
    for (;;) {
      control.onProgress?.({ stage: "render", completed: 2, total: 4 });
      const poll = await pollAvatarVideo(videoId, control, deps);
      if (poll.state === "FAILED") throw new SpeechProviderError(poll.errorMessage ?? "AVATAR_PROVIDER_RENDER_FAILED", "UNKNOWN", false);
      if (poll.state === "SUCCEEDED" && poll.videoUrl) {
        control.onProgress?.({ stage: "download", completed: 3, total: 4 });
        const file = await downloadAvatarVideo(poll.videoUrl, control, deps);
        control.onProgress?.({ stage: "done", completed: 4, total: 4, percent: 100 });
        return { state: "SUCCEEDED", videoId, testMode: submitted.testMode, video: file.data, sha256: file.sha256, durationSeconds: poll.durationSeconds };
      }
      if (Date.now() >= deadline) throw new SpeechProviderError("AVATAR_RENDER_WAIT_EXCEEDED", "TIMEOUT", true);
      await sleep(interval, control.signal);
    }
  } catch (error) {
    const mapped = toSpeechError(error, control);
    if (mapped.failureClass === "CANCELLED") {
      return { state: "CANCELLED_LOCAL", videoId, providerCancelSupported: false, note: "Polling stopped. HeyGen documents no cancel for in-flight renders; the provider job may still complete and incur cost. Reconcile by video id." };
    }
    throw mapped;
  }
}
