export type MediaEngineKind =
  | "image"
  | "video"
  | "speech_to_text"
  | "text_to_speech"
  | "music"
  | "avatar"
  | "live_multimodal";

export type MediaProviderKind = "local" | "self_hosted" | "external";
export type MediaBillingMode = "local_compute" | "metered_api" | "subscription";
export type MediaJobState = "queued" | "running" | "partial" | "succeeded" | "failed" | "cancelled";

export interface MediaAssetRef {
  assetId: string;
  mediaType?: string;
  checksumSha256?: string;
}

export interface RightsReference {
  recordId: string;
  subjectType: "person" | "voice" | "brand" | "music" | "source_asset" | "other";
  purpose: string;
  validUntil?: string;
  revocable: boolean;
}

export interface ProvenanceReference {
  recordId: string;
  sourceAssetIds?: string[];
  modelOrEngineId?: string;
}

export interface MediaRequestContext {
  requestId: string;
  tenantId: string;
  idempotencyKey: string;
  allowExternalProviders: boolean;
  allowMeteredSpend: boolean;
  rights: RightsReference[];
  provenance?: ProvenanceReference;
}

export interface MediaCapabilityDescriptor {
  id: string;
  engineKind: MediaEngineKind;
  providerKind: MediaProviderKind;
  billingMode: MediaBillingMode;
  runtimeEnabled: boolean;
  capabilities: readonly string[];
  supportsCancellation: boolean;
  supportsProgressEvents: boolean;
  supportsIdempotency: boolean;
}

export interface MediaProgressEvent {
  requestId: string;
  state: MediaJobState;
  progressPercent?: number;
  message?: string;
  completedAssetIds?: string[];
}

export interface MediaCostMetadata {
  billingMode: MediaBillingMode;
  estimatedCost?: number;
  actualCost?: number;
  currency?: string;
  computeSeconds?: number;
}

export interface MediaQualityMetadata {
  automaticChecks?: Record<string, number | boolean | string>;
  humanReviewRequired: boolean;
  humanReviewStatus?: "pending" | "pass" | "fail";
}

export interface MediaResult {
  requestId: string;
  state: MediaJobState;
  assets: MediaAssetRef[];
  provenance: ProvenanceReference;
  cost: MediaCostMetadata;
  quality: MediaQualityMetadata;
}

export type MediaErrorCode =
  | "ENGINE_UNAVAILABLE"
  | "CAPABILITY_UNSUPPORTED"
  | "EXTERNAL_PROVIDER_NOT_APPROVED"
  | "METERED_SPEND_NOT_APPROVED"
  | "RIGHTS_OR_CONSENT_REQUIRED"
  | "QUOTA_EXHAUSTED"
  | "TIMEOUT"
  | "INPUT_INVALID"
  | "ASSET_CORRUPTED"
  | "CANCELLED"
  | "UNKNOWN";

export interface MediaEngineError {
  code: MediaErrorCode;
  message: string;
  retryable: boolean;
  preserveInputs: boolean;
}

export interface ImageEngineRequest {
  context: MediaRequestContext;
  prompt: string;
  references?: MediaAssetRef[];
  mask?: MediaAssetRef;
  width?: number;
  height?: number;
}

export interface VideoEngineRequest {
  context: MediaRequestContext;
  prompt: string;
  references?: MediaAssetRef[];
  firstFrame?: MediaAssetRef;
  lastFrame?: MediaAssetRef;
  durationSeconds?: number;
  width?: number;
  height?: number;
}

export interface SpeechToTextRequest {
  context: MediaRequestContext;
  audio: MediaAssetRef;
  languageHints?: string[];
  diarization?: boolean;
}

export interface TextToSpeechRequest {
  context: MediaRequestContext;
  text: string;
  language?: string;
  voiceProfileId?: string;
  emotionTags?: string[];
}

export interface MusicEngineRequest {
  context: MediaRequestContext;
  prompt: string;
  durationSeconds?: number;
  referenceAudio?: MediaAssetRef[];
}

export interface AvatarEngineRequest {
  context: MediaRequestContext;
  avatarProfileId: string;
  audio?: MediaAssetRef;
  text?: string;
  background?: MediaAssetRef;
}

export interface LiveMultimodalRequest {
  context: MediaRequestContext;
  sessionId: string;
  enabledModalities: readonly ("text" | "audio" | "image" | "video" | "screen" | "camera")[];
}
