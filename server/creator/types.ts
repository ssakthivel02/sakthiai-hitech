export const CREATOR_JOB_STATES = [
  "QUEUED",
  "SUBMITTED",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "RETRYABLE",
] as const;

export type CreatorJobState = (typeof CREATOR_JOB_STATES)[number];
export type CreatorMediaKind = "IMAGE" | "IMAGE_EDIT" | "VIDEO" | "VIDEO_EXTENSION";
export type CreatorFailureClass =
  | "AUTH"
  | "QUOTA"
  | "RATE_LIMIT"
  | "INVALID_REQUEST"
  | "CONTENT_POLICY"
  | "PROVIDER_UNAVAILABLE"
  | "TIMEOUT"
  | "NETWORK"
  | "ARTIFACT"
  | "UNKNOWN";

export interface CreatorInlineImage {
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  dataBase64: string;
  assetId?: number;
}

export interface CreatorImageRequest {
  kind: "IMAGE" | "IMAGE_EDIT";
  prompt: string;
  model?: string;
  aspectRatio?: string;
  imageSize?: string;
  references?: CreatorInlineImage[];
}

export interface CreatorVideoRequest {
  kind: "VIDEO" | "VIDEO_EXTENSION";
  prompt: string;
  model?: string;
  aspectRatio?: "16:9" | "9:16";
  resolution?: "720p" | "1080p" | "4k";
  durationSeconds?: 4 | 6 | 8;
  firstFrame?: CreatorInlineImage;
  lastFrame?: CreatorInlineImage;
  references?: CreatorInlineImage[];
  sourceVideoAssetId?: number;
}

export type CreatorMediaRequest = CreatorImageRequest | CreatorVideoRequest;

export interface CreatorProviderCapabilities {
  imageGeneration?: boolean;
  imageEditing?: boolean;
  textToVideo?: boolean;
  imageToVideo?: boolean;
  firstLastFrame?: boolean;
  referenceImages?: number;
  videoExtension?: boolean;
  aspectRatios?: readonly string[];
  resolutions?: readonly string[];
}

export interface CreatorProviderStatus {
  provider: string;
  configured: boolean;
  defaultModel: string;
  capabilities: CreatorProviderCapabilities;
}

export interface CreatorProviderSubmission {
  providerJobId: string;
  state: "SUBMITTED" | "RUNNING" | "SUCCEEDED";
  provider: string;
  model: string;
  raw: unknown;
  costMicros?: number;
  currency?: string;
}

export interface CreatorProviderArtifact {
  mimeType: string;
  uri?: string;
  dataBase64?: string;
}

export interface CreatorFetchedArtifact {
  mimeType: string;
  data: Uint8Array;
}

export interface CreatorProviderPoll {
  providerJobId: string;
  state: "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED" | "RETRYABLE";
  raw: unknown;
  artifacts: CreatorProviderArtifact[];
  failureClass?: CreatorFailureClass;
  errorMessage?: string;
  costMicros?: number;
  currency?: string;
}

export interface CreatorMediaProvider {
  readonly id: string;
  status(): CreatorProviderStatus;
  supports(request: CreatorMediaRequest): boolean;
  submit(request: CreatorMediaRequest): Promise<CreatorProviderSubmission>;
  poll(providerJobId: string): Promise<CreatorProviderPoll>;
  cancel?(providerJobId: string): Promise<CreatorProviderPoll>;
  fetchArtifact?(artifact: CreatorProviderArtifact): Promise<CreatorFetchedArtifact>;
  classifyFailure(error: unknown): CreatorFailureClass;
}

const ALLOWED_TRANSITIONS: Record<CreatorJobState, readonly CreatorJobState[]> = {
  QUEUED: ["SUBMITTED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED"],
  SUBMITTED: ["RUNNING", "SUCCEEDED", "FAILED", "CANCELLED", "RETRYABLE"],
  RUNNING: ["SUCCEEDED", "FAILED", "CANCELLED", "RETRYABLE"],
  // Provider completion can precede SakthiAI-controlled artifact persistence. A
  // persistence failure must be able to reopen only into RETRYABLE; it still
  // cannot jump back to QUEUED/RUNNING and cannot silently regenerate media.
  SUCCEEDED: ["RETRYABLE"],
  FAILED: [],
  CANCELLED: [],
  RETRYABLE: ["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED"],
};

export function canTransitionCreatorJob(from: CreatorJobState, to: CreatorJobState): boolean {
  return from === to || ALLOWED_TRANSITIONS[from].includes(to);
}

export function assertCreatorJobTransition(from: CreatorJobState, to: CreatorJobState): void {
  if (!canTransitionCreatorJob(from, to)) {
    throw new Error(`CREATOR_INVALID_JOB_TRANSITION_${from}_TO_${to}`);
  }
}

export function isCreatorTerminalState(state: CreatorJobState): boolean {
  return state === "SUCCEEDED" || state === "FAILED" || state === "CANCELLED";
}
