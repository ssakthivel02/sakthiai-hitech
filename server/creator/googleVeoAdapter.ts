import {
  googleVeoStatus,
  pollGoogleVeo,
  submitGoogleVeo,
  type CreatorVeoRequest,
  type VeoOperationSnapshot,
} from "./googleVeo";
import type { CreatorFailureClass, CreatorMediaProvider, CreatorProviderArtifact } from "./types";

const SUPPORTED_MODELS = new Set([
  "veo-3.1-generate-preview",
  "veo-3.1-fast-generate-preview",
  "veo-3.1-lite-generate-preview",
]);

function errorText(error: unknown): string {
  if (error instanceof Error) {
    const cause = "cause" in error ? JSON.stringify(error.cause) : "";
    return `${error.message} ${cause}`;
  }
  return typeof error === "string" ? error : JSON.stringify(error);
}

export function classifyGoogleVeoFailure(error: unknown): CreatorFailureClass {
  const combined = errorText(error).toLowerCase();
  if (combined.includes("401") || combined.includes("403") || combined.includes("api key")) return "AUTH";
  if (combined.includes("quota") || combined.includes("resource_exhausted")) return "QUOTA";
  if (combined.includes("429") || combined.includes("rate")) return "RATE_LIMIT";
  if (combined.includes("safety") || combined.includes("policy") || combined.includes("blocked")) return "CONTENT_POLICY";
  if (combined.includes("400") || combined.includes("invalid") || combined.includes("unsupported")) return "INVALID_REQUEST";
  if (combined.includes("408") || combined.includes("504") || combined.includes("timeout")) return "TIMEOUT";
  if (combined.includes("500") || combined.includes("502") || combined.includes("503") || combined.includes("unavailable")) return "PROVIDER_UNAVAILABLE";
  if (combined.includes("fetch") || combined.includes("network")) return "NETWORK";
  return "UNKNOWN";
}

export function extractGoogleVeoArtifacts(snapshot: VeoOperationSnapshot): CreatorProviderArtifact[] {
  const response = snapshot.response as {
    generateVideoResponse?: {
      generatedSamples?: Array<{ video?: { uri?: string; mimeType?: string } }>;
    };
  } | undefined;
  const samples = response?.generateVideoResponse?.generatedSamples ?? [];
  return samples.flatMap(sample => {
    const uri = sample.video?.uri;
    return uri ? [{ mimeType: sample.video?.mimeType || "video/mp4", uri }] : [];
  });
}

function toVeoRequest(request: Parameters<CreatorMediaProvider["supports"]>[0]): CreatorVeoRequest {
  if (request.kind !== "VIDEO") throw new Error("CREATOR_VEO_KIND_UNSUPPORTED");
  if (request.model && !SUPPORTED_MODELS.has(request.model)) throw new Error("CREATOR_VEO_MODEL_UNSUPPORTED");
  return {
    prompt: request.prompt,
    model: request.model as CreatorVeoRequest["model"],
    aspectRatio: request.aspectRatio,
    resolution: request.resolution,
    durationSeconds: request.durationSeconds,
    firstFrame: request.firstFrame,
    lastFrame: request.lastFrame,
    referenceImages: request.references,
  };
}

export const googleVeoProvider: CreatorMediaProvider = {
  id: "google-veo",

  status() {
    const status = googleVeoStatus();
    return {
      provider: "google-veo",
      configured: status.configured,
      defaultModel: status.defaultModel,
      capabilities: {
        textToVideo: true,
        imageToVideo: true,
        firstLastFrame: true,
        referenceImages: 3,
        videoExtension: false,
        aspectRatios: ["16:9", "9:16"],
        resolutions: ["720p", "1080p", "4k"],
      },
    };
  },

  supports(request) {
    return request.kind === "VIDEO" && (!request.model || SUPPORTED_MODELS.has(request.model));
  },

  async submit(request) {
    const mapped = toVeoRequest(request);
    const operation = await submitGoogleVeo(mapped);
    if (operation.error) throw new Error(errorText(operation.error));
    return {
      providerJobId: operation.name,
      state: operation.done ? "SUCCEEDED" : "SUBMITTED",
      provider: "google-veo",
      model: mapped.model ?? googleVeoStatus().defaultModel,
      raw: operation,
    };
  },

  async poll(providerJobId) {
    const operation = await pollGoogleVeo(providerJobId);
    const artifacts = extractGoogleVeoArtifacts(operation);
    if (operation.error) {
      const failureClass = classifyGoogleVeoFailure(operation.error);
      const retryable = ["RATE_LIMIT", "QUOTA", "PROVIDER_UNAVAILABLE", "TIMEOUT", "NETWORK"].includes(failureClass);
      return {
        providerJobId,
        state: retryable ? "RETRYABLE" : "FAILED",
        raw: operation,
        artifacts,
        failureClass,
        errorMessage: errorText(operation.error).slice(0, 2000),
      };
    }
    if (!operation.done) return { providerJobId, state: "RUNNING", raw: operation, artifacts };
    if (artifacts.length === 0) {
      return {
        providerJobId,
        state: "FAILED",
        raw: operation,
        artifacts,
        failureClass: "ARTIFACT",
        errorMessage: "GOOGLE_VEO_OUTPUT_MISSING",
      };
    }
    return { providerJobId, state: "SUCCEEDED", raw: operation, artifacts };
  },

  classifyFailure: classifyGoogleVeoFailure,
};
