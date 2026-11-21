export const CAPABILITY_STATUSES = [
  "shipped_source",
  "foundation_ready",
  "active_lane",
  "planned",
  "external_gate",
  "reconcile_existing",
] as const;

export type CapabilityStatus = (typeof CAPABILITY_STATUSES)[number];

export const CAPABILITY_DOMAINS = [
  "chat_reasoning",
  "research_search",
  "coding_build",
  "agents_automation",
  "knowledge_memory",
  "documents_data",
  "image_creation",
  "video_creation",
  "audio_voice_music",
  "avatar_digital_human",
  "multimodal_live",
  "apps_web_artifacts",
  "connectors_actions",
  "enterprise_trust",
  "model_fabric_local_ai",
  "operations_observability",
] as const;

export type CapabilityDomain = (typeof CAPABILITY_DOMAINS)[number];

export interface SakthiCapability {
  id: string;
  domain: CapabilityDomain;
  label: string;
  status: CapabilityStatus;
  ownerLane: "main" | "core-intelligence-pr25" | "creator-pr7" | "future" | "reconcile";
  zeroSpendTarget: boolean;
  humanApprovalRequired?: boolean;
  notes?: string;
}

type Group = {
  domain: CapabilityDomain;
  status: CapabilityStatus;
  ownerLane: SakthiCapability["ownerLane"];
  zeroSpendTarget: boolean;
  features: readonly string[];
};

const groups: readonly Group[] = [
  {
    domain: "chat_reasoning",
    status: "planned",
    ownerLane: "future",
    zeroSpendTarget: true,
    features: [
      "adaptive-chat", "instant-mode", "deep-reasoning-mode", "max-reasoning-mode", "multilingual-chat",
      "tamil-first-chat", "structured-output", "long-context-chat", "conversation-branching", "conversation-search",
      "conversation-pinning", "response-regeneration", "response-comparison", "self-verification", "uncertainty-reporting",
      "citation-aware-chat", "context-compaction", "prompt-library", "personal-instructions", "workspace-instructions",
    ],
  },
  {
    domain: "research_search",
    status: "planned",
    ownerLane: "future",
    zeroSpendTarget: true,
    features: [
      "web-search", "deep-research", "multi-query-planning", "parallel-search", "source-authority-ranking",
      "freshness-ranking", "citation-coverage", "claim-source-linking", "research-notebook", "research-memory",
      "academic-search", "news-search", "finance-search", "site-restricted-search", "document-web-fusion",
      "research-agent", "research-report", "fact-cross-check", "contradiction-detection", "source-confidence",
    ],
  },
  {
    domain: "coding_build",
    status: "planned",
    ownerLane: "future",
    zeroSpendTarget: true,
    features: [
      "repo-understanding", "code-search", "multi-file-edit", "code-generation", "code-review", "bug-fix",
      "test-generation", "test-execution", "terminal-agent", "dependency-analysis", "migration-planning", "refactoring",
      "performance-analysis", "security-review", "frontend-from-design", "screenshot-visual-check", "app-scaffolding",
      "git-diff-review", "rollback-plan", "release-note-generation",
    ],
  },
  {
    domain: "agents_automation",
    status: "foundation_ready",
    ownerLane: "core-intelligence-pr25",
    zeroSpendTarget: true,
    features: [
      "task-planner", "task-graph", "specialist-agents", "multi-agent-orchestration", "agent-swarm", "parallel-subagents",
      "checkpoint-resume", "bounded-retries", "tool-budget", "approval-gates", "risk-classification", "verifier-agent",
      "critic-agent", "synthesizer-agent", "background-tasks", "scheduled-tasks", "condition-monitoring", "long-running-jobs",
      "task-history", "failure-recovery", "human-in-the-loop", "agent-handoff", "plan-mode", "branching-workflows",
    ],
  },
  {
    domain: "knowledge_memory",
    status: "planned",
    ownerLane: "future",
    zeroSpendTarget: true,
    features: [
      "lexical-rag", "semantic-rag", "hybrid-rag", "reranking", "tenant-isolated-retrieval", "memory-short-term",
      "memory-long-term", "user-memory", "project-memory", "agent-memory", "knowledge-graph", "entity-linking",
      "provenance", "source-confidence", "freshness-decay", "memory-compaction", "memory-editing", "memory-forgetting",
      "cross-file-retrieval", "retrieval-evaluation",
    ],
  },
  {
    domain: "documents_data",
    status: "planned",
    ownerLane: "future",
    zeroSpendTarget: true,
    features: [
      "pdf-understanding", "docx-understanding", "xlsx-understanding", "pptx-understanding", "ocr", "table-extraction",
      "chart-understanding", "document-citations", "document-comparison", "document-translation", "document-rewrite",
      "spreadsheet-analysis", "spreadsheet-generation", "presentation-generation", "pdf-generation", "data-cleaning",
      "data-visualization", "sandboxed-python", "artifact-versioning", "artifact-export",
    ],
  },
  {
    domain: "image_creation",
    status: "planned",
    ownerLane: "future",
    zeroSpendTarget: true,
    features: [
      "text-to-image", "image-to-image", "image-edit", "inpaint", "outpaint", "background-remove", "background-replace",
      "transparent-image", "style-transfer", "reference-image", "multi-reference-image", "character-consistency",
      "product-image", "poster-design", "infographic-generation", "diagram-generation", "ui-mockup-generation",
      "text-rendering-in-image", "image-upscale", "image-restoration", "face-preserving-edit", "batch-image-generation",
    ],
  },
  {
    domain: "video_creation",
    status: "active_lane",
    ownerLane: "creator-pr7",
    zeroSpendTarget: false,
    features: [
      "text-to-video", "image-to-video", "script-to-video", "message-to-video", "story-to-video", "storyboard-to-video",
      "first-last-frame-video", "reference-video", "video-to-video", "video-restyle", "scene-generation", "shot-generation",
      "video-extension", "video-upscale", "video-interpolation", "video-captioning", "subtitle-burn-in", "subtitle-sidecar",
      "timeline-editor", "clip-trim", "clip-split", "clip-merge", "transition-engine", "camera-motion-control",
      "aspect-ratio-conversion", "shorts-reframe", "cinematic-color", "ffmpeg-render", "render-resume", "video-provenance",
    ],
  },
  {
    domain: "audio_voice_music",
    status: "planned",
    ownerLane: "future",
    zeroSpendTarget: true,
    features: [
      "speech-to-text", "streaming-stt", "speaker-diarization", "language-identification", "forced-alignment",
      "text-to-speech", "expressive-tts", "multilingual-tts", "voice-design", "consent-based-voice-clone", "voice-conversion",
      "speech-translation", "live-translation", "audio-denoise", "audio-enhance", "audio-trim", "audio-mix", "audio-master",
      "stem-separation", "sound-effect-generation", "text-to-music", "instrumental-generation", "song-generation",
      "lyrics-assisted-song", "music-extension", "music-remix", "podcast-generation", "audiobook-generation",
    ],
  },
  {
    domain: "avatar_digital_human",
    status: "planned",
    ownerLane: "future",
    zeroSpendTarget: true,
    features: [
      "photo-to-avatar", "custom-avatar", "avatar-to-video", "scripted-avatar-video", "talking-photo", "lip-sync",
      "multilingual-lip-sync", "avatar-voice", "avatar-background", "avatar-gestures", "avatar-emotion", "avatar-camera",
      "digital-human-live", "avatar-brand-kit", "avatar-scene-template", "avatar-consistency", "consent-record",
    ],
  },
  {
    domain: "multimodal_live",
    status: "planned",
    ownerLane: "future",
    zeroSpendTarget: true,
    features: [
      "image-understanding", "video-understanding", "audio-understanding", "screen-understanding", "camera-understanding",
      "live-voice", "full-duplex-voice", "interruptible-voice", "live-vision", "screen-share-assistant", "meeting-assistant",
      "real-time-translation", "multimodal-reasoning", "cross-modal-search", "cross-modal-memory", "event-understanding",
    ],
  },
  {
    domain: "apps_web_artifacts",
    status: "planned",
    ownerLane: "future",
    zeroSpendTarget: true,
    features: [
      "website-builder", "web-app-builder", "mobile-app-builder", "dashboard-builder", "form-builder", "workflow-builder",
      "presentation-builder", "document-builder", "spreadsheet-builder", "interactive-artifact", "generative-ui", "preview-runtime",
      "sandbox-runtime", "one-click-export", "hosting-adapter", "custom-domain-adapter", "seo-assistant", "accessibility-audit",
    ],
  },
  {
    domain: "connectors_actions",
    status: "planned",
    ownerLane: "future",
    zeroSpendTarget: true,
    features: [
      "browser-control", "computer-use", "filesystem-tools", "shell-tools", "github-connector", "gitlab-connector",
      "gmail-connector", "outlook-connector", "calendar-connector", "drive-connector", "slack-connector", "teams-connector",
      "notion-connector", "database-connector", "cloud-connector", "mcp-client", "mcp-server", "a2a-protocol",
      "webhook-runtime", "api-tool-builder", "custom-skill-builder", "connector-permissioning",
    ],
  },
  {
    domain: "enterprise_trust",
    status: "planned",
    ownerLane: "future",
    zeroSpendTarget: true,
    features: [
      "authentication", "oidc", "sso", "rbac", "tenant-isolation", "workspace-isolation", "project-isolation",
      "secret-management", "approval-policy", "audit-log", "data-retention", "privacy-controls", "export-delete-data",
      "content-provenance", "watermark-verification", "prompt-injection-defense", "tool-sandbox", "network-egress-policy",
      "spend-policy", "quota-policy", "abuse-detection", "safety-policy", "admin-console", "organization-controls",
    ],
  },
  {
    domain: "model_fabric_local_ai",
    status: "foundation_ready",
    ownerLane: "core-intelligence-pr25",
    zeroSpendTarget: true,
    features: [
      "model-registry", "capability-routing", "intent-routing", "reasoning-effort-routing", "compute-aware-routing",
      "local-first-routing", "self-hosted-routing", "external-provider-gate", "metered-spend-gate", "fallback-routing",
      "ensemble-routing", "specialist-model-routing", "benchmark-driven-selection", "local-llm-adapter", "local-vlm-adapter",
      "local-embedding-adapter", "local-stt-adapter", "local-tts-adapter", "local-image-adapter", "local-video-adapter",
      "quantized-model-support", "cpu-inference", "gpu-inference", "model-health", "model-version-pinning",
    ],
  },
  {
    domain: "operations_observability",
    status: "planned",
    ownerLane: "future",
    zeroSpendTarget: true,
    features: [
      "health-check", "readiness-check", "release-identity", "structured-logging", "trace-id", "distributed-tracing",
      "metrics", "latency-dashboard", "cost-dashboard", "token-dashboard", "gpu-dashboard", "queue-dashboard", "agent-dashboard",
      "capability-dashboard", "evaluation-dashboard", "error-budget", "slo-sla", "rate-limits", "circuit-breaker",
      "retry-policy", "rollback", "backup-restore", "disaster-recovery", "feature-flags", "canary-release",
      "runtime-drift-detection", "security-monitoring", "quality-regression-gate",
    ],
  },
] as const;

function titleize(id: string): string {
  return id.split("-").map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

export const SAKTHIAI_MASTER_CAPABILITIES: readonly SakthiCapability[] = groups.flatMap(group =>
  group.features.map(id => ({
    id: `${group.domain}.${id}`,
    domain: group.domain,
    label: titleize(id),
    status: group.status,
    ownerLane: group.ownerLane,
    zeroSpendTarget: group.zeroSpendTarget,
  })),
);

export const MASTER_CAPABILITY_COUNT = SAKTHIAI_MASTER_CAPABILITIES.length;

export function capabilitiesByDomain(domain: CapabilityDomain): SakthiCapability[] {
  return SAKTHIAI_MASTER_CAPABILITIES.filter(capability => capability.domain === domain);
}

export function capabilityById(id: string): SakthiCapability | undefined {
  return SAKTHIAI_MASTER_CAPABILITIES.find(capability => capability.id === id);
}
