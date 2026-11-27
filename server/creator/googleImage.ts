import type {
  CreatorFailureClass,
  CreatorImageRequest,
  CreatorMediaProvider,
  CreatorProviderArtifact,
  CreatorProviderPoll,
} from "./types";

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_MODEL = "gemini-3.1-flash-image";
const SUPPORTED_ASPECT_RATIOS = new Set(["1:1", "9:16", "16:9"]);
const SUPPORTED_IMAGE_SIZES = new Set(["1K", "2K", "4K"]);
const MAX_REFERENCE_IMAGES = 4;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

type Interaction = {
  id?: string;
  model?: string;
  status?: string;
  steps?: Array<{
    type?: string;
    content?: Array<{ type?: string; data?: string; mime_type?: string; uri?: string }>;
  }>;
  error?: unknown;
};

class GoogleImageHttpError extends Error {
  constructor(message: string, readonly status: number, readonly payload: unknown) {
    super(message);
  }
}

function runtimeConfig() {
  return {
    apiKey: process.env.GEMINI_API_KEY ?? "",
    baseUrl: DEFAULT_BASE_URL,
  };
}

const ALLOWED_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_IMAGE_BASE64_LENGTH = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;

/**
 * Validate the encoded length BEFORE allocating decoded bytes. Node's base64
 * decoder is permissive, so require canonical padding and reject data-URI
 * MIME mismatches rather than accepting a different media type under an
 * image/png label.
 */
function validateInlineImage(dataBase64: string, expectedMimeType?: string): string {
  if (expectedMimeType && !ALLOWED_IMAGE_MIME_TYPES.has(expectedMimeType)) {
    throw new Error("CREATOR_IMAGE_MIME_UNSUPPORTED");
  }
  if (typeof dataBase64 !== "string" || dataBase64.length > MAX_IMAGE_BASE64_LENGTH + 64) {
    throw new Error("CREATOR_IMAGE_SIZE_INVALID");
  }
  const trimmed = dataBase64.trim();
  const uriMatch = /^data:([^;,]+);base64,/i.exec(trimmed);
  if (trimmed.startsWith("data:") && !uriMatch) throw new Error("CREATOR_IMAGE_INVALID_BASE64");
  if (uriMatch && (!ALLOWED_IMAGE_MIME_TYPES.has(uriMatch[1].toLowerCase()) ||
    (expectedMimeType && uriMatch[1].toLowerCase() !== expectedMimeType))) {
    throw new Error("CREATOR_IMAGE_MIME_MISMATCH");
  }
  const data = (uriMatch ? trimmed.slice(uriMatch[0].length) : trimmed).replace(/\r?\n/g, "");
  if (!data || data.length > MAX_IMAGE_BASE64_LENGTH) throw new Error("CREATOR_IMAGE_SIZE_INVALID");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
    throw new Error("CREATOR_IMAGE_INVALID_BASE64");
  }
  const bytes = Buffer.from(data, "base64");
  if (!bytes.byteLength || bytes.byteLength > MAX_IMAGE_BYTES) throw new Error("CREATOR_IMAGE_SIZE_INVALID");
  if (bytes.toString("base64") !== data) throw new Error("CREATOR_IMAGE_INVALID_BASE64");
  assertGoogleImageSignature(bytes, expectedMimeType ?? uriMatch?.[1].toLowerCase() ?? "image/png");
  return data;
}


/** Reject mislabeled or obviously truncated image bytes before persistence. */
export function assertGoogleImageSignature(data: Uint8Array, mimeType: string): void {
  const isPng = data.length >= 45 &&
    [137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => data[i] === n) &&
    [73, 72, 68, 82].every((n, i) => data[12 + i] === n) &&
    [0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130].every((n, i) => data[data.length - 12 + i] === n);
  const isJpeg = data.length >= 4 && data[0] === 255 && data[1] === 216 &&
    data[2] === 255 && data[data.length - 2] === 255 && data[data.length - 1] === 217;
  const isWebp = data.length >= 12 &&
    [82, 73, 70, 70].every((n, i) => data[i] === n) &&
    [87, 69, 66, 80].every((n, i) => data[8 + i] === n) &&
    ((data[4] | (data[5] << 8) | (data[6] << 16) | (data[7] << 24)) >>> 0) === data.length - 8;
  if (!((mimeType === "image/png" && isPng) ||
    (mimeType === "image/jpeg" && isJpeg) ||
    (mimeType === "image/webp" && isWebp))) {
    throw new Error("CREATOR_IMAGE_SIGNATURE_MISMATCH");
  }
}

/** Only the first-party Gemini API host may receive x-goog-api-key. */
export function validateGoogleImageArtifactUri(uri: string): URL {
  let parsed: URL;
  try { parsed = new URL(uri); }
  catch { throw new Error("CREATOR_IMAGE_ARTIFACT_URI_INVALID"); }
  if (parsed.protocol !== "https:" || parsed.hostname !== "generativelanguage.googleapis.com" ||
      parsed.port || parsed.username || parsed.password) {
    throw new Error("CREATOR_IMAGE_ARTIFACT_URI_INVALID");
  }
  return parsed;
}

/** Enforce the image byte budget even when Content-Length is absent or dishonest. */
export async function readBoundedGoogleImageBody(response: Response, maxBytes = MAX_IMAGE_BYTES): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_IMAGE_BYTES) {
    throw new Error("CREATOR_IMAGE_ARTIFACT_LIMIT_INVALID");
  }
  const rawLength = response.headers.get("content-length");
  if (rawLength !== null && !/^(0|[1-9][0-9]*)$/.test(rawLength)) {
    try { await response.body?.cancel(); } catch { /* preserve validation error */ }
    throw new Error("CREATOR_IMAGE_ARTIFACT_LENGTH_INVALID");
  }
  const declaredLength = rawLength === null ? undefined : Number(rawLength);
  if (declaredLength !== undefined && (!Number.isSafeInteger(declaredLength) || declaredLength > maxBytes)) {
    try { await response.body?.cancel(); } catch { /* preserve validation error */ }
    throw new Error("CREATOR_IMAGE_ARTIFACT_TOO_LARGE");
  }
  if (!response.body) throw new Error("CREATOR_IMAGE_ARTIFACT_EMPTY");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new Error("CREATOR_IMAGE_ARTIFACT_CHUNK_INVALID");
      if (value.byteLength > maxBytes - received) throw new Error("CREATOR_IMAGE_ARTIFACT_TOO_LARGE");
      chunks.push(value);
      received += value.byteLength;
    }
    if (!received) throw new Error("CREATOR_IMAGE_ARTIFACT_EMPTY");
    if (declaredLength !== undefined && received !== declaredLength) {
      throw new Error("CREATOR_IMAGE_ARTIFACT_LENGTH_MISMATCH");
    }
    const data = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return data;
  } finally {
    try { await reader.cancel(); } catch { /* preserve original error */ }
    reader.releaseLock();
  }
}

export async function fetchGoogleImageArtifact(artifact: CreatorProviderArtifact) {
  if (artifact.dataBase64) return decodeGoogleImageArtifact(artifact);
  if (!artifact.uri) throw new Error("CREATOR_IMAGE_ARTIFACT_DATA_MISSING");
  const apiKey = runtimeConfig().apiKey;
  if (!apiKey) throw new Error("GOOGLE_IMAGE_NOT_CONFIGURED");
  const uri = validateGoogleImageArtifactUri(artifact.uri);
  const response = await fetch(uri, {
    headers: { "x-goog-api-key": apiKey },
    redirect: "error",
  });
  if (!response.ok) throw new Error("GOOGLE_IMAGE_ARTIFACT_DOWNLOAD_FAILED_" + response.status);
  const rawMimeType = response.headers.get("content-type");
  const responseMimeType = rawMimeType?.split(";")[0].trim().toLowerCase();
  const declaredMimeType = artifact.mimeType?.trim().toLowerCase();
  if ((responseMimeType && !ALLOWED_IMAGE_MIME_TYPES.has(responseMimeType)) ||
      (declaredMimeType && !ALLOWED_IMAGE_MIME_TYPES.has(declaredMimeType))) {
    throw new Error("CREATOR_IMAGE_MIME_UNSUPPORTED");
  }
  if (responseMimeType && declaredMimeType && responseMimeType !== declaredMimeType) {
    throw new Error("CREATOR_IMAGE_MIME_MISMATCH");
  }
  const mimeType = responseMimeType || declaredMimeType;
  if (!mimeType) throw new Error("CREATOR_IMAGE_MIME_UNSUPPORTED");
  const data = await readBoundedGoogleImageBody(response);
  assertGoogleImageSignature(data, mimeType);
  return { mimeType, data };
}

export function buildGoogleImagePayload(request: CreatorImageRequest) {
  const prompt = request.prompt.trim();
  if (!prompt || prompt.length > 8000) throw new Error("CREATOR_PROMPT_INVALID");
  const model = request.model ?? DEFAULT_MODEL;
  if (model !== DEFAULT_MODEL) throw new Error("CREATOR_IMAGE_MODEL_UNSUPPORTED");
  const aspectRatio = request.aspectRatio ?? "16:9";
  if (!SUPPORTED_ASPECT_RATIOS.has(aspectRatio)) throw new Error("CREATOR_IMAGE_ASPECT_RATIO_UNSUPPORTED");
  const imageSize = request.imageSize ?? "2K";
  if (!SUPPORTED_IMAGE_SIZES.has(imageSize)) throw new Error("CREATOR_IMAGE_SIZE_UNSUPPORTED");
  const references = request.references ?? [];
  if (references.length > MAX_REFERENCE_IMAGES) throw new Error("CREATOR_IMAGE_REFERENCE_LIMIT_EXCEEDED");
  if (request.kind === "IMAGE_EDIT" && references.length === 0) throw new Error("CREATOR_IMAGE_EDIT_REQUIRES_REFERENCE");

  const input: Array<Record<string, unknown>> = [{ type: "text", text: prompt }];
  for (const reference of references) {
    input.push({ type: "image", mime_type: reference.mimeType, data: validateInlineImage(reference.dataBase64, reference.mimeType) });
  }

  return {
    model,
    body: {
      model,
      input,
      response_format: {
        type: "image",
        mime_type: "image/png",
        aspect_ratio: aspectRatio,
        image_size: imageSize,
      },
    },
  };
}

export function extractGoogleImageArtifacts(payload: unknown): CreatorProviderArtifact[] {
  const interaction = payload as Interaction;
  const artifacts: CreatorProviderArtifact[] = [];
  for (const step of interaction.steps ?? []) {
    if (step.type !== "model_output") continue;
    for (const content of step.content ?? []) {
      if (content.type === "image" && (content.data || content.uri)) {
        artifacts.push({ mimeType: content.mime_type || (content.data ? "image/png" : ""), dataBase64: content.data, uri: content.uri });
      }
    }
  }
  return artifacts;
}

export function decodeGoogleImageArtifact(artifact: CreatorProviderArtifact) {
  if (!artifact.dataBase64) throw new Error("CREATOR_IMAGE_ARTIFACT_DATA_MISSING");
  const mimeType = artifact.mimeType || "image/png";
  const data = validateInlineImage(artifact.dataBase64, mimeType);
  return { mimeType, data: new Uint8Array(Buffer.from(data, "base64")) };
}

function mapInteraction(payload: Interaction, providerJobId: string): CreatorProviderPoll {
  const artifacts = extractGoogleImageArtifacts(payload);
  if (payload.status === "cancelled") return { providerJobId, state: "CANCELLED", raw: payload, artifacts };
  if (payload.status === "failed" || payload.status === "budget_exceeded" || payload.status === "incomplete") {
    return {
      providerJobId,
      state: payload.status === "budget_exceeded" ? "RETRYABLE" : "FAILED",
      raw: payload,
      artifacts,
      failureClass: payload.status === "budget_exceeded" ? "QUOTA" : "UNKNOWN",
      errorMessage: `GOOGLE_IMAGE_INTERACTION_${payload.status.toUpperCase()}`,
    };
  }
  if (payload.status === "completed") {
    if (artifacts.length === 0) {
      return { providerJobId, state: "FAILED", raw: payload, artifacts, failureClass: "ARTIFACT", errorMessage: "GOOGLE_IMAGE_OUTPUT_MISSING" };
    }
    return { providerJobId, state: "SUCCEEDED", raw: payload, artifacts };
  }
  return { providerJobId, state: "RUNNING", raw: payload, artifacts };
}

async function requestInteraction(url: string, init?: RequestInit): Promise<Interaction> {
  // Never follow a redirect: the x-goog-api-key header is NOT stripped by fetch on a cross-origin redirect, so following one would hand the
  // provider key (and the prompt) to whatever host the response names.
  const response = await fetch(url, { ...init, redirect: "error" });
  const payload = (await response.json()) as Interaction;
  if (!response.ok) throw new GoogleImageHttpError(`GOOGLE_IMAGE_HTTP_${response.status}`, response.status, payload);
  return payload;
}

export function classifyGoogleImageFailure(error: unknown): CreatorFailureClass {
  const httpError = error instanceof GoogleImageHttpError ? error : undefined;
  const status = httpError?.status;
  const message = `${error instanceof Error ? error.message : ""} ${httpError ? JSON.stringify(httpError.payload) : ""}`.toLowerCase();
  if (status === 401 || status === 403) return "AUTH";
  if (status === 429 && message.includes("quota")) return "QUOTA";
  if (status === 429) return "RATE_LIMIT";
  if (status === 400 && (message.includes("safety") || message.includes("policy") || message.includes("blocked"))) return "CONTENT_POLICY";
  if (status === 400 || status === 404 || status === 422) return "INVALID_REQUEST";
  if (status === 408 || status === 504) return "TIMEOUT";
  if (status === 500 || status === 502 || status === 503) return "PROVIDER_UNAVAILABLE";
  if (message.includes("fetch") || message.includes("network")) return "NETWORK";
  return "UNKNOWN";
}

export const googleImageProvider: CreatorMediaProvider = {
  id: "google-gemini-image",

  status() {
    return {
      provider: "google-gemini-image",
      configured: Boolean(runtimeConfig().apiKey),
      defaultModel: DEFAULT_MODEL,
      capabilities: {
        imageGeneration: true,
        imageEditing: true,
        aspectRatios: ["1:1", "9:16", "16:9"],
      },
    };
  },

  supports(request) {
    return (request.kind === "IMAGE" || request.kind === "IMAGE_EDIT") && (!request.model || request.model === DEFAULT_MODEL);
  },

  async submit(request) {
    if (request.kind !== "IMAGE" && request.kind !== "IMAGE_EDIT") throw new Error("CREATOR_PROVIDER_KIND_UNSUPPORTED");
    const config = runtimeConfig();
    if (!config.apiKey) throw new Error("GOOGLE_IMAGE_NOT_CONFIGURED");
    const { model, body } = buildGoogleImagePayload(request);
    const payload = await requestInteraction(`${config.baseUrl}/interactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": config.apiKey },
      body: JSON.stringify(body),
    });
    if (!payload.id) throw new Error("GOOGLE_IMAGE_INTERACTION_ID_MISSING");
    const mapped = mapInteraction(payload, payload.id);
    if (mapped.state === "FAILED" || mapped.state === "CANCELLED" || mapped.state === "RETRYABLE") {
      throw new Error(mapped.errorMessage || `GOOGLE_IMAGE_${mapped.state}`);
    }
    return {
      providerJobId: payload.id,
      state: mapped.state === "SUCCEEDED" ? "SUCCEEDED" : "RUNNING",
      provider: "google-gemini-image",
      model,
      raw: payload,
    };
  },

  async poll(providerJobId) {
    const config = runtimeConfig();
    if (!config.apiKey) throw new Error("GOOGLE_IMAGE_NOT_CONFIGURED");
    const payload = await requestInteraction(`${config.baseUrl}/interactions/${encodeURIComponent(providerJobId)}`, {
      headers: { "x-goog-api-key": config.apiKey },
    });
    return mapInteraction(payload, providerJobId);
  },

  async fetchArtifact(artifact) {
    return fetchGoogleImageArtifact(artifact);
  },

  classifyFailure: classifyGoogleImageFailure,
};
