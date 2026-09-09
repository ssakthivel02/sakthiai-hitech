export type VeoModel =
  | "veo-3.1-generate-preview"
  | "veo-3.1-fast-generate-preview"
  | "veo-3.1-lite-generate-preview";

export type VeoAspectRatio = "16:9" | "9:16";
export type VeoResolution = "720p" | "1080p" | "4k";
export type VeoDurationSeconds = 4 | 6 | 8;

export interface CreatorImageInput {
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  dataBase64: string;
}

export interface CreatorVeoRequest {
  prompt: string;
  model?: VeoModel;
  aspectRatio?: VeoAspectRatio;
  resolution?: VeoResolution;
  durationSeconds?: VeoDurationSeconds;
  firstFrame?: CreatorImageInput;
  lastFrame?: CreatorImageInput;
  referenceImages?: CreatorImageInput[];
}

export interface VeoOperationSnapshot {
  name: string;
  done?: boolean;
  response?: unknown;
  error?: unknown;
}

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_MODEL: VeoModel = "veo-3.1-fast-generate-preview";
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

function normalizeBase64(value: string): string {
  return value.replace(/^data:[^;]+;base64,/, "").trim();
}

function toInlineData(image: CreatorImageInput) {
  const data = normalizeBase64(image.dataBase64);
  if (!data || !/^[A-Za-z0-9+/=\r\n]+$/.test(data)) {
    throw new Error("CREATOR_IMAGE_INVALID_BASE64");
  }
  const byteLength = Buffer.from(data, "base64").byteLength;
  if (!byteLength || byteLength > MAX_IMAGE_BYTES) {
    throw new Error("CREATOR_IMAGE_SIZE_INVALID");
  }
  return { inlineData: { mimeType: image.mimeType, data } };
}

function validateOperationName(value: string): string {
  if (!value || value.startsWith("/") || value.includes("..") || !/^[A-Za-z0-9._/-]+$/.test(value)) {
    throw new Error("CREATOR_OPERATION_NAME_INVALID");
  }
  return value;
}

export function validateVeoRequest(input: CreatorVeoRequest): Required<
  Pick<CreatorVeoRequest, "model" | "aspectRatio" | "resolution" | "durationSeconds">
> & CreatorVeoRequest {
  const prompt = input.prompt.trim();
  if (!prompt || prompt.length > 8000) throw new Error("CREATOR_PROMPT_INVALID");

  const model = input.model ?? DEFAULT_MODEL;
  const aspectRatio = input.aspectRatio ?? "16:9";
  const resolution = input.resolution ?? "720p";
  const durationSeconds = input.durationSeconds ?? 8;
  const references = input.referenceImages ?? [];

  if (input.lastFrame && !input.firstFrame) throw new Error("CREATOR_LAST_FRAME_REQUIRES_FIRST_FRAME");
  if (references.length > 3) throw new Error("CREATOR_REFERENCE_LIMIT_EXCEEDED");
  if ((resolution === "1080p" || resolution === "4k" || references.length > 0) && durationSeconds !== 8) {
    throw new Error("CREATOR_VEO_REQUIRES_8_SECONDS");
  }
  if (model === "veo-3.1-lite-generate-preview" && (resolution === "4k" || references.length > 0)) {
    throw new Error("CREATOR_VEO_LITE_UNSUPPORTED_CONFIGURATION");
  }

  return {
    ...input,
    prompt,
    model,
    aspectRatio,
    resolution,
    durationSeconds,
    referenceImages: references,
  };
}

export function buildVeoPayload(input: CreatorVeoRequest) {
  const request = validateVeoRequest(input);
  const instance: Record<string, unknown> = { prompt: request.prompt };

  if (request.firstFrame) instance.image = toInlineData(request.firstFrame);
  if (request.lastFrame) instance.lastFrame = toInlineData(request.lastFrame);
  if (request.referenceImages?.length) {
    instance.referenceImages = request.referenceImages.map(image => ({
      image: toInlineData(image),
      referenceType: "asset",
    }));
  }

  const usesImageConditioning = Boolean(request.firstFrame || request.referenceImages?.length);

  return {
    model: request.model,
    body: {
      instances: [instance],
      parameters: {
        numberOfVideos: 1,
        aspectRatio: request.aspectRatio,
        durationSeconds: request.durationSeconds,
        resolution: request.resolution,
        personGeneration: usesImageConditioning ? "allow_adult" : "allow_all",
      },
    },
  };
}

function runtimeConfig() {
  return {
    apiKey: process.env.GEMINI_API_KEY ?? "",
    baseUrl: (process.env.GOOGLE_VEO_API_BASE ?? DEFAULT_BASE_URL).replace(/\/$/, ""),
  };
}

export function googleVeoStatus() {
  const config = runtimeConfig();
  return {
    provider: "google-veo" as const,
    configured: Boolean(config.apiKey),
    defaultModel: DEFAULT_MODEL,
    supports: {
      textToVideo: true,
      imageToVideo: true,
      firstLastFrame: true,
      referenceImages: 3,
      aspectRatios: ["16:9", "9:16"] as const,
      resolutions: ["720p", "1080p", "4k"] as const,
    },
  };
}

export async function submitGoogleVeo(input: CreatorVeoRequest): Promise<VeoOperationSnapshot> {
  const config = runtimeConfig();
  if (!config.apiKey) throw new Error("GOOGLE_VEO_NOT_CONFIGURED");

  const { model, body } = buildVeoPayload(input);
  const response = await fetch(`${config.baseUrl}/models/${model}:predictLongRunning`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": config.apiKey,
    },
    body: JSON.stringify(body),
  });

  const payload = (await response.json()) as VeoOperationSnapshot;
  if (!response.ok) {
    const error = new Error(`GOOGLE_VEO_SUBMIT_FAILED_${response.status}`);
    Object.assign(error, { cause: payload });
    throw error;
  }
  if (!payload.name) throw new Error("GOOGLE_VEO_OPERATION_MISSING");
  return payload;
}

export async function pollGoogleVeo(operationName: string): Promise<VeoOperationSnapshot> {
  const config = runtimeConfig();
  if (!config.apiKey) throw new Error("GOOGLE_VEO_NOT_CONFIGURED");
  const safeName = validateOperationName(operationName);

  const response = await fetch(`${config.baseUrl}/${safeName}`, {
    headers: { "x-goog-api-key": config.apiKey },
  });
  const payload = (await response.json()) as VeoOperationSnapshot;
  if (!response.ok) {
    const error = new Error(`GOOGLE_VEO_POLL_FAILED_${response.status}`);
    Object.assign(error, { cause: payload });
    throw error;
  }
  return payload;
}
