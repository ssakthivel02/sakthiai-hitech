import { createHash } from "node:crypto";
import { callSignal, classifyHttpStatus, SpeechProviderError, toSpeechError, type CallControl, type FetchLike } from "./types";

/**
 * HeyGen v3 talking-avatar adapter: mocked contract only; no approved live API call.
 *   POST /v3/assets multipart { file } -> data.asset_id, 32 MB maximum.
 *   POST /v3/videos { type:"avatar", avatar_id, audio_asset_id } -> data.video_id.
 *   GET /v3/videos/{video_id} -> data.status/video_url/failure_message.
 *
 * STATUS: CONTRACT_TESTED against documented shapes only; NO live call has been made from this repository.
 * v3 provider compatibility requires owner-approved live acceptance; mocks alone do not prove compatibility.
 *
 * CANCELLATION: no provider-side cancel endpoint is documented for in-flight renders (only permanent delete).
 * Aborting therefore stops polling and returns the provider video id for reconciliation; provider-side work and cost
 * may still complete. That is reported as `providerCancelSupported: false`, never as a successful cancel.
 *
 * COST CONTROL: v3 does not document the old free test mode. Only explicitly approved `live:true` may submit.
 */
export const HEYGEN_ENDPOINTS = {
  upload: "https://api.heygen.com/v3/assets",
  generate: "https://api.heygen.com/v3/videos",
  status: "https://api.heygen.com/v3/videos",
} as const;

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 10_000;
const DEFAULT_MAX_WAIT_MS = 20 * 60_000;
const MAX_VIDEO_BYTES = 512 * 1024 * 1024;
const MAX_V3_AUDIO_BYTES = 32 * 1024 * 1024;
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
  // Provider error bodies are untrusted. Preserve status without buffering them.
  try { await response.body?.cancel(); } catch { /* preserve HTTP error */ }
  throw new SpeechProviderError(`AVATAR_PROVIDER_HTTP_${response.status}`, failureClass, retryable, response.status);
}

function idOf(value: unknown, code: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{4,128}$/.test(value)) throw new SpeechProviderError(code, "ARTIFACT", true);
  return value;
}

export async function uploadAvatarAudio(audio: Buffer, contentType: "audio/wav" | "audio/mpeg", control: CallControl = {}, deps: HeygenDeps = {}): Promise<{ assetId: string }> {
  if (!audio.length) throw new SpeechProviderError("AVATAR_AUDIO_EMPTY", "INVALID_REQUEST", false);
  if (audio.length > MAX_V3_AUDIO_BYTES) throw new SpeechProviderError("AVATAR_AUDIO_V3_UPLOAD_TOO_LARGE", "INVALID_REQUEST", false);
  const doFetch = deps.fetch ?? fetch;
  try {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(audio)], { type: contentType }), contentType === "audio/wav" ? "approved.wav" : "approved.mp3");
    const response = await doFetch(HEYGEN_ENDPOINTS.upload, {
      method: "POST",
      headers: { "x-api-key": key(deps) },
      body: form,
      redirect: "error",
      signal: callSignal(control.signal, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    if (!response.ok) await failFromResponse(response);
    const payload = (await response.json()) as { data?: { asset_id?: unknown } };
    return { assetId: idOf(payload.data?.asset_id, "AVATAR_UPLOAD_ASSET_ID_MISSING") };
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
  /** Explicitly billable v3 generation, approved by caller gates. */
  live?: boolean;
};

export function buildAvatarGeneratePayload(request: AvatarSubmitRequest) {
  if (request.live !== true) throw new SpeechProviderError("AVATAR_V3_LIVE_APPROVAL_REQUIRED", "INVALID_REQUEST", false);
  idOf(request.avatarId, "AVATAR_ID_INVALID");
  idOf(request.audioAssetId, "AVATAR_AUDIO_ASSET_INVALID");
  if (!/^[A-Za-z0-9_.:-]{8,128}$/.test(request.callbackId)) throw new SpeechProviderError("AVATAR_CALLBACK_ID_INVALID", "INVALID_REQUEST", false);
  const width = request.width ?? 1920;
  const height = request.height ?? 1080;
  if (![width, height].every(value => Number.isInteger(value) && value >= 360 && value <= 4096)) throw new SpeechProviderError("AVATAR_DIMENSION_INVALID", "INVALID_REQUEST", false);
  return {
    type: "avatar" as const,
    avatar_id: request.avatarId,
    audio_asset_id: request.audioAssetId,
    title: (request.title ?? "SakthiAI avatar video").slice(0, 120),
    callback_id: request.callbackId,
    aspect_ratio: "auto" as const,
    resolution: "1080p" as const,
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
    return { videoId: idOf(payload.data?.video_id, "AVATAR_SUBMIT_VIDEO_ID_MISSING"), testMode: false };
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
  const data = (payload as { data?: { status?: unknown; video_url?: unknown; duration?: unknown; failure_message?: unknown } } | null)?.data;
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
    const response = await doFetch(`${HEYGEN_ENDPOINTS.status}/${encodeURIComponent(videoId)}`, {
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
    const lengthHeader = response.headers.get("content-length");
    if (lengthHeader !== null && !/^(0|[1-9][0-9]*)$/.test(lengthHeader)) {
      try { await response.body?.cancel(); } catch { /* preserve invalid-header failure */ }
      throw new SpeechProviderError("AVATAR_DOWNLOAD_LENGTH_INVALID", "ARTIFACT", false);
    }
    const declared = lengthHeader === null ? undefined : Number(lengthHeader);
    if (declared !== undefined && !Number.isSafeInteger(declared)) {
      try { await response.body?.cancel(); } catch { /* preserve invalid-header failure */ }
      throw new SpeechProviderError("AVATAR_DOWNLOAD_LENGTH_INVALID", "ARTIFACT", false);
    }
    if (declared !== undefined && declared > MAX_VIDEO_BYTES) {
      try { await response.body?.cancel(); } catch { /* preserve size failure */ }
      throw new SpeechProviderError("AVATAR_DOWNLOAD_TOO_LARGE", "ARTIFACT", false);
    }
    if (!response.body) throw new SpeechProviderError("AVATAR_DOWNLOAD_EMPTY", "ARTIFACT", true);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!(value instanceof Uint8Array)) throw new SpeechProviderError("AVATAR_DOWNLOAD_CHUNK_INVALID", "ARTIFACT", false);
        if (value.byteLength > MAX_VIDEO_BYTES - total) throw new SpeechProviderError("AVATAR_DOWNLOAD_TOO_LARGE", "ARTIFACT", false);
        chunks.push(value);
        total += value.byteLength;
      }
      if (!total) throw new SpeechProviderError("AVATAR_DOWNLOAD_EMPTY", "ARTIFACT", true);
      if (declared !== undefined && declared !== total) throw new SpeechProviderError("AVATAR_DOWNLOAD_LENGTH_MISMATCH", "ARTIFACT", false);
    } finally {
      try { await reader.cancel(); } catch { /* preserve original error */ }
      reader.releaseLock();
    }
    // Allocate output exactly once; avoid an intermediate copy of each chunk.
    const data = Buffer.allocUnsafe(total);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.byteLength;
    }
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
    if (input.live !== true) throw new SpeechProviderError("AVATAR_V3_LIVE_APPROVAL_REQUIRED", "INVALID_REQUEST", false);
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
