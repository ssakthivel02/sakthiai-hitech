import type { CapabilityDomain, SakthiCapability } from "./catalog";
import { SAKTHIAI_MASTER_CAPABILITIES } from "./catalog";

type ExtensionGroup = {
  domain: CapabilityDomain;
  features: readonly string[];
};

const extensionGroups: readonly ExtensionGroup[] = [
  {
    domain: "chat_reasoning",
    features: [
      "prompt-optimizer", "prompt-debugger", "multi-model-response-compare", "consensus-answer", "debate-mode",
      "tutor-mode", "expert-mode", "creative-mode", "role-workspaces", "reusable-personas", "context-inspector",
      "token-context-meter", "answer-replay", "answer-versioning", "cross-conversation-context", "team-chat",
    ],
  },
  {
    domain: "research_search",
    features: [
      "web-crawler", "site-indexer", "watchlist-monitoring", "change-detection", "competitive-intelligence",
      "patent-search", "standards-search", "legal-source-search", "source-archive", "research-dataset-export",
      "research-replay", "evidence-ledger", "citation-health-check", "source-deduplication", "research-task-scheduler",
    ],
  },
  {
    domain: "coding_build",
    features: [
      "ide-extension", "background-coding-agent", "pull-request-agent", "issue-to-code-agent", "codebase-map",
      "symbol-graph", "dependency-upgrade-agent", "package-vulnerability-fix", "containerfile-generation", "iac-generation",
      "ci-workflow-generation", "database-schema-designer", "api-contract-generator", "sdk-generator", "visual-regression-testing",
      "browser-e2e-generation", "release-automation-plan", "monorepo-support", "mobile-build-agent", "desktop-app-builder",
    ],
  },
  {
    domain: "agents_automation",
    features: [
      "autonomy-levels", "agent-template-library", "agent-team-chat", "agent-to-agent-messaging", "agent-delegation-policy",
      "agent-memory-policy", "agent-sandbox-snapshot", "agent-replay", "agent-evaluation", "agent-marketplace",
      "workflow-template-library", "event-driven-agents", "email-triggered-agents", "calendar-triggered-agents", "webhook-triggered-agents",
      "approval-inbox", "agent-cost-budget", "agent-time-budget", "agent-resource-budget", "agent-escalation",
    ],
  },
  {
    domain: "knowledge_memory",
    features: [
      "knowledge-ingestion-pipeline", "continuous-indexing", "vector-index-builder", "vector-store-abstraction", "graph-rag",
      "multi-hop-rag", "query-rewrite", "query-decomposition", "contextual-compression", "chunking-strategy-lab",
      "embedding-benchmark", "retrieval-cache", "knowledge-freshness-monitor", "knowledge-permission-sync", "memory-policy-engine",
      "memory-conflict-resolution", "memory-provenance", "memory-export", "memory-import", "memory-encryption",
    ],
  },
  {
    domain: "documents_data",
    features: [
      "dataset-studio", "data-labeling", "annotation-workbench", "synthetic-data-generation", "multimodal-dataset-builder",
      "schema-inference", "json-csv-parquet-tools", "sql-analysis", "notebook-generation", "notebook-execution",
      "dashboard-from-data", "data-quality-rules", "pii-detection", "data-redaction", "document-form-filling",
      "document-signature-workflow", "document-template-engine", "bulk-document-processing", "email-attachment-ingestion", "archive-ingestion",
    ],
  },
  {
    domain: "image_creation",
    features: [
      "controlnet-style-guidance", "pose-guidance", "depth-guidance", "edge-guidance", "image-layout-control",
      "logo-generation", "brand-consistency", "ad-creative-generation", "thumbnail-generation", "comic-generation",
      "storyboard-generation", "image-variation-grid", "image-seed-control", "image-negative-prompt", "image-metadata-provenance",
      "image-rights-record", "image-safety-review", "batch-image-edit", "smart-crop", "super-resolution-pipeline",
    ],
  },
  {
    domain: "video_creation",
    features: [
      "talking-head-video", "product-video", "ad-video", "document-to-video", "presentation-to-video",
      "podcast-to-video", "audio-to-video", "video-background-remove", "video-object-remove", "video-object-replace",
      "video-background-replace", "video-face-preserving-edit", "video-character-consistency", "video-motion-transfer", "video-style-transfer",
      "video-stabilization", "video-denoise", "video-color-match", "video-audio-sync", "video-scene-detection",
      "video-highlight-extraction", "video-summary", "video-chaptering", "video-rights-record", "video-watermark-provenance",
    ],
  },
  {
    domain: "audio_voice_music",
    features: [
      "midi-generation", "midi-editing", "beat-generation", "melody-generation", "harmony-generation",
      "vocal-generation", "vocal-isolation", "instrument-isolation", "music-style-transfer", "music-structure-control",
      "music-section-edit", "music-inpainting", "music-outpainting", "loudness-normalization", "audio-spatialization",
      "audio-rights-record", "voice-consent-verification", "voice-watermark-provenance", "pronunciation-dictionary", "voice-emotion-control",
    ],
  },
  {
    domain: "avatar_digital_human",
    features: [
      "avatar-identity-lock", "avatar-clothing-control", "avatar-scene-consistency", "avatar-full-body", "avatar-multi-person-scene",
      "avatar-interview-mode", "avatar-podcast-mode", "avatar-training-video", "avatar-product-demo", "avatar-live-stream",
      "avatar-real-time-translation", "avatar-accessibility-signing", "avatar-consent-expiry", "avatar-revocation", "avatar-rights-record",
    ],
  },
  {
    domain: "multimodal_live",
    features: [
      "live-object-detection", "live-scene-description", "live-ocr", "live-document-camera", "live-whiteboard-understanding",
      "live-code-screen-help", "live-browser-co-pilot", "live-meeting-notes", "live-action-items", "live-speaker-attribution",
      "live-voice-cloning-disabled-by-default", "live-safety-interrupt", "low-latency-streaming", "multimodal-session-record", "sensor-event-ingestion",
    ],
  },
  {
    domain: "apps_web_artifacts",
    features: [
      "api-builder", "backend-builder", "database-app-builder", "internal-tool-builder", "chatbot-builder",
      "agent-app-builder", "chrome-extension-builder", "desktop-app-builder", "pwa-builder", "real-time-collaboration",
      "comments-review", "artifact-version-history", "artifact-forking", "template-marketplace", "extension-marketplace",
      "plugin-marketplace", "3d-model-generation", "3d-scene-generation", "texture-generation", "mesh-editing",
      "spatial-scene-builder", "ar-export", "vr-export", "game-prototype-builder", "digital-twin-prototype",
    ],
  },
  {
    domain: "connectors_actions",
    features: [
      "public-api", "rest-api", "graphql-api", "websocket-api", "realtime-api",
      "typescript-sdk", "python-sdk", "java-sdk", "dotnet-sdk", "mobile-sdk",
      "cli", "oauth-app-framework", "connector-marketplace", "connector-health", "connector-audit",
      "api-gateway", "api-rate-policy", "api-key-management", "service-account-management", "event-bus",
    ],
  },
  {
    domain: "enterprise_trust",
    features: [
      "scim", "domain-verification", "session-revocation", "device-session-management", "mfa",
      "passkeys", "kms-integration", "customer-managed-keys", "encryption-at-rest", "encryption-in-transit",
      "data-residency", "dlp", "legal-hold", "ediscovery", "policy-as-code",
      "model-allowlist", "connector-allowlist", "ip-allowlist", "private-networking", "audit-export",
      "usage-metering", "billing-controls", "chargeback", "showback", "license-management",
    ],
  },
  {
    domain: "model_fabric_local_ai",
    features: [
      "fine-tuning", "lora", "qlora", "adapter-registry", "adapter-routing",
      "model-distillation", "synthetic-training-data", "dataset-curation", "model-conversion", "model-quantization-pipeline",
      "gguf-support", "onnx-support", "tensorrt-support", "mlx-support", "vllm-support",
      "llama-cpp-support", "ollama-support", "transformers-support", "tokenizer-management", "model-cache-management",
      "model-download-manager", "model-license-registry", "model-card-registry", "model-eval-harness", "prompt-eval-harness",
      "preference-evaluation", "human-feedback-dataset", "routing-bandit", "routing-ab-test", "hardware-profiler",
      "cpu-profile", "apple-silicon-profile", "nvidia-gpu-profile", "amd-gpu-profile", "edge-device-profile",
    ],
  },
  {
    domain: "operations_observability",
    features: [
      "benchmark-lab", "red-team-suite", "evaluation-replay", "golden-dataset", "regression-corpus",
      "experiment-tracking", "prompt-telemetry", "model-telemetry", "retrieval-telemetry", "tool-telemetry",
      "agent-telemetry", "media-quality-dashboard", "human-review-dashboard", "release-evidence-ledger", "incident-management",
      "on-call-runbook", "postmortem-workflow", "capacity-planning", "autoscaling-policy", "queue-priority-policy",
      "tenant-usage-dashboard", "workspace-usage-dashboard", "feature-adoption-dashboard", "quality-drift-alert", "cost-anomaly-alert",
    ],
  },
] as const;

function titleize(id: string): string {
  return id.split("-").map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

export const SAKTHIAI_SCOPE_EXTENSIONS: readonly SakthiCapability[] = extensionGroups.flatMap(group =>
  group.features.map(feature => ({
    id: `${group.domain}.${feature}`,
    domain: group.domain,
    label: titleize(feature),
    status: "planned" as const,
    ownerLane: "future" as const,
    zeroSpendTarget: true,
  })),
);

export const COMPLETE_SAKTHIAI_CAPABILITIES: readonly SakthiCapability[] = [
  ...SAKTHIAI_MASTER_CAPABILITIES,
  ...SAKTHIAI_SCOPE_EXTENSIONS,
];

export const SCOPE_EXTENSION_COUNT = SAKTHIAI_SCOPE_EXTENSIONS.length;
export const COMPLETE_SAKTHIAI_CAPABILITY_COUNT = COMPLETE_SAKTHIAI_CAPABILITIES.length;

export function validateCompleteCapabilityRegistry(): string[] {
  const ids = COMPLETE_SAKTHIAI_CAPABILITIES.map(capability => capability.id);
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  return Array.from(new Set(duplicates));
}
