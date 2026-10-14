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

function normalizeBase64(value: string): string {
  return value.replace(/^data:[^;]+;base64,/, "").trim();
}

function validateInlineImage(dataBase64: string): string {
  const data = normalizeBase64(dataBase64);
  if (!data || !/^[A-Za-z0-9+/=\r\n]+$/.test(data)) throw new Error("CREATOR_IMAGE_INVALID_BASE64");
  const byteLength = Buffer.from(data, "base64").byteLength;
  if (!byteLength || byteLength > MAX_IMAGE_BYTES) throw new Error("CREATOR_IMAGE_SIZE_INVALID");
  return data;
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
    input.push({ type: "image", mime_type: reference.mimeType, data: validateInlineImage(reference.dataBase64) });
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
        artifacts.push({ mimeType: content.mime_type || "image/png", dataBase64: content.data, uri: content.uri });
      }
    }
  }
  return artifacts;
}

export function decodeGoogleImageArtifact(artifact: CreatorProviderArtifact) {
  if (!artifact.dataBase64) throw new Error("CREATOR_IMAGE_ARTIFACT_DATA_MISSING");
  const data = validateInlineImage(artifact.dataBase64);
  return { mimeType: artifact.mimeType || "image/png", data: new Uint8Array(Buffer.from(data, "base64")) };
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
  const response = await fetch(url, init);
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
    return decodeGoogleImageArtifact(artifact);
  },

  classifyFailure: classifyGoogleImageFailure,
};
