export const MODEL_CAPABILITIES = [
  "chat",
  "reasoning",
  "coding",
  "vision",
  "long_context",
  "tool_use",
  "research",
  "computer_use",
  "agents",
  "structured_output",
  "multilingual",
  "speech",
  "image_generation",
  "video_generation",
] as const;

export type ModelCapability = (typeof MODEL_CAPABILITIES)[number];

export const TASK_INTENTS = [
  "conversation",
  "analysis",
  "research",
  "coding",
  "document_work",
  "data_analysis",
  "browser_work",
  "automation",
  "vision",
  "creative",
] as const;

export type TaskIntent = (typeof TASK_INTENTS)[number];
export type ReasoningEffort = "none" | "low" | "medium" | "high" | "max";
export type ProviderKind = "local" | "self_hosted" | "external";
export type BillingMode = "local_compute" | "metered_api" | "subscription";
export type ImplementationStatus = "available" | "planned" | "reference_only";

export interface ComputeEnvelope {
  cpuCores: number;
  ramGb: number;
  vramGb: number;
  gpuCount: number;
  networkAllowed: boolean;
}

export interface ModelProfile {
  id: string;
  label: string;
  family: string;
  providerKind: ProviderKind;
  billingMode: BillingMode;
  openWeights: boolean;
  requiresApiKey: boolean;
  runtimeEnabled: boolean;
  implementationStatus: ImplementationStatus;
  capabilities: readonly ModelCapability[];
  preferredIntents: readonly TaskIntent[];
  reasoningEfforts: readonly ReasoningEffort[];
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  qualityTier: 1 | 2 | 3 | 4 | 5;
  resourceFloor: {
    cpuCores: number;
    ramGb: number;
    vramGb: number;
    gpuCount: number;
  };
  notes?: string;
}

export interface RoutingRequest {
  intents: readonly TaskIntent[];
  requiredCapabilities?: readonly ModelCapability[];
  optionalCapabilities?: readonly ModelCapability[];
  reasoningEffort?: ReasoningEffort;
  allowExternalProviders?: boolean;
  allowMeteredBilling?: boolean;
  compute?: Partial<ComputeEnvelope>;
}

export interface RejectedCandidate {
  modelId: string;
  reasons: string[];
}

export interface RankedCandidate {
  model: ModelProfile;
  score: number;
  reasons: string[];
}

export interface RoutingDecision {
  selected?: RankedCandidate;
  alternatives: RankedCandidate[];
  rejected: RejectedCandidate[];
}
