export interface CompetitorCapabilityReference {
  id: string;
  productFamily: string;
  publicStrengths: readonly string[];
  publicTradeoffsToBeat: readonly string[];
  sakthiAIResponse: readonly string[];
  evidenceDate: string;
  evidenceSource: string;
}

/**
 * Evidence-backed product capability references, not a ranking.
 * This registry tracks public strengths and explicit/product-level tradeoffs so
 * SakthiAI can convert competitor gaps into design requirements without copying
 * proprietary weights, training data, hidden prompts, or private internals.
 */
export const COMPETITOR_CAPABILITY_REFERENCES: readonly CompetitorCapabilityReference[] = [
  {
    id: "openai-gpt6-chatgpt",
    productFamily: "OpenAI GPT-6 / ChatGPT",
    publicStrengths: ["frontier reasoning", "computer use", "browsing", "software engineering", "vision", "tool use", "large context"],
    publicTradeoffsToBeat: ["frontier inference is proprietary", "metered API use creates external spend and dependency"],
    sakthiAIResponse: ["local-first Model Fabric", "computer/browser skill sandbox", "reasoning-effort routing", "optional funded provider adapters only"],
    evidenceDate: "2026-09-24",
    evidenceSource: "OpenAI GPT-6 Astra page and OpenAI model catalog",
  },
  {
    id: "anthropic-claude-fable",
    productFamily: "Anthropic Claude Fable 5.1",
    publicStrengths: ["long-running agents", "coding", "browser operation", "knowledge work", "vision over documents", "self-checking workflows"],
    publicTradeoffsToBeat: ["proprietary hosted model", "paid access for highest-capability use"],
    sakthiAIResponse: ["bounded durable agents", "verifier layer", "local/self-hosted model option", "evidence-first coding workflow"],
    evidenceDate: "2026-09-24",
    evidenceSource: "Anthropic Claude Fable 5.1 product page",
  },
  {
    id: "google-gemini",
    productFamily: "Google Gemini 3.8 / Gemini Omni / Spark",
    publicStrengths: ["live voice", "extended-thinking voice", "agentic workflows", "proactive agents", "multimodal video generation", "TTS", "cross-app actions"],
    publicTradeoffsToBeat: ["major capabilities depend on Google-hosted services", "some experiences vary by plan or region"],
    sakthiAIResponse: ["provider-independent live multimodal contract", "local STT/TTS pathway", "media-engine abstraction", "portable agent scheduler"],
    evidenceDate: "2026-09-24",
    evidenceSource: "Google Gemini model docs and 2026 Gemini product announcements",
  },
  {
    id: "moonshot-kimi-k3",
    productFamily: "Moonshot Kimi K3",
    publicStrengths: ["open weights", "native vision", "1M context", "long-horizon coding", "agent tasks", "agent swarm"],
    publicTradeoffsToBeat: ["2.8T total parameters make practical self-hosting extremely compute-heavy", "frontier quality still depends on large inference infrastructure"],
    sakthiAIResponse: ["tiered local profiles", "compute-aware routing", "small-model specialists", "swarm orchestration independent of one giant model"],
    evidenceDate: "2026-09-24",
    evidenceSource: "Kimi K3 technical blog and Kimi Agent help center",
  },
  {
    id: "deepseek-v4",
    productFamily: "DeepSeek V4.1",
    publicStrengths: ["efficient MoE architecture", "native visual understanding", "high-throughput agent workloads", "reduced KV-cache footprint"],
    publicTradeoffsToBeat: ["hundreds of billions of total parameters remain heavy for small-budget self-hosting", "model-specific infrastructure can create lock-in"],
    sakthiAIResponse: ["resource-floor routing", "quantized-model support", "multiple interchangeable local runtimes", "benchmark-driven activation"],
    evidenceDate: "2026-09-24",
    evidenceSource: "DeepSeek V4.1-Flash announcement",
  },
  {
    id: "qwen-family",
    productFamily: "Qwen 3.7 / 3.8 Omni / Image / ASR",
    publicStrengths: ["open multimodal models", "agentic coding", "long-horizon tool use", "image generation/editing", "ASR", "omnimodal agent work", "broad multilingual support"],
    publicTradeoffsToBeat: ["capabilities are spread across multiple specialist models and runtimes", "larger variants still require meaningful inference hardware"],
    sakthiAIResponse: ["single Model Fabric over specialist engines", "one shared UX", "media/audio adapters", "automatic capability routing"],
    evidenceDate: "2026-09-24",
    evidenceSource: "Qwen official 2026 model and research releases",
  },
  {
    id: "mistral-family",
    productFamily: "Mistral generalist + specialist models",
    publicStrengths: ["open-weight general models", "small edge models", "multimodal", "agentic coding", "OCR", "speech models"],
    publicTradeoffsToBeat: ["best capability may require selecting/orchestrating several specialist models"],
    sakthiAIResponse: ["automatic specialist routing", "unified retrieval/media/voice toolchain", "local edge-to-GPU deployment profiles"],
    evidenceDate: "2026-09-24",
    evidenceSource: "Mistral official models and documentation",
  },
  {
    id: "xai-grok",
    productFamily: "Grok 4.7 / Grok Voice",
    publicStrengths: ["long-running coding", "knowledge work", "self-checking", "long-context management", "real-world speech transcription"],
    publicTradeoffsToBeat: ["frontier runtime is proprietary and externally hosted"],
    sakthiAIResponse: ["local coding specialists", "verification contracts", "open STT adapter", "runtime-independent agent layer"],
    evidenceDate: "2026-09-24",
    evidenceSource: "xAI Grok 4.7 and Grok Voice Transcribe 2.0 announcements",
  },
  {
    id: "perplexity-computer",
    productFamily: "Perplexity Search / Computer / Brain",
    publicStrengths: ["real-time cited research", "multi-model orchestration", "browser agent", "continuous monitoring", "connectors", "memory/Brain", "file/app creation"],
    publicTradeoffsToBeat: ["many advanced capabilities are subscription-tier features", "web-first workflows depend on external services"],
    sakthiAIResponse: ["grounding and provenance by default", "local-first Brain", "self-hostable scheduler", "optional web research rather than mandatory dependency"],
    evidenceDate: "2026-09-24",
    evidenceSource: "Perplexity product, Computer, Pro and Max documentation",
  },
  {
    id: "manus-agent",
    productFamily: "Manus",
    publicStrengths: ["autonomous task planning", "cloud computer", "browser operator", "scheduled tasks", "connectors", "website/app/slides/video creation", "parallel branches", "projects and reusable skills"],
    publicTradeoffsToBeat: ["agent mode and complex execution consume service credits", "execution depends on hosted cloud-computer infrastructure"],
    sakthiAIResponse: ["zero-spend-capable control plane", "self-hostable skills", "portable computer-use sandbox", "bounded task execution with explicit spend gates"],
    evidenceDate: "2026-09-24",
    evidenceSource: "Manus official product blog and help center",
  },
  {
    id: "runway-creative",
    productFamily: "Runway",
    publicStrengths: ["prompt-driven video editing", "character/object replacement", "background replacement", "VFX", "multi-shot editing"],
    publicTradeoffsToBeat: ["advanced generative rendering is hosted and credit/resource intensive"],
    sakthiAIResponse: ["modular video edit pipeline", "local FFmpeg baseline", "optional qualified generative engines", "non-destructive timeline and provenance"],
    evidenceDate: "2026-09-24",
    evidenceSource: "Runway Edit Studio documentation",
  },
  {
    id: "heygen-avatar",
    productFamily: "HeyGen",
    publicStrengths: ["custom avatars", "talking avatar video", "voice cloning", "lip sync", "multilingual translation", "avatar gesture/delivery control"],
    publicTradeoffsToBeat: ["higher-end avatar and translation workflows are hosted/plan-dependent"],
    sakthiAIResponse: ["consent-based avatar identity layer", "provider-independent avatar engine contract", "local dubbing/subtitle fallback", "multilingual media workflow"],
    evidenceDate: "2026-09-24",
    evidenceSource: "HeyGen avatar and video translation documentation",
  },
  {
    id: "suno-music",
    productFamily: "Suno v6 / Studio",
    publicStrengths: ["text-to-song", "multimodal music prompting", "section editing", "remix/mashup", "sound generation", "MIDI and DAW-like editing"],
    publicTradeoffsToBeat: ["flagship creation/editing features are partly subscription-gated", "music generation raises rights/provenance requirements"],
    sakthiAIResponse: ["music-engine abstraction", "rights/provenance metadata", "local audio editing", "consent/licensing-aware generation policy"],
    evidenceDate: "2026-09-24",
    evidenceSource: "Suno v6 and Studio 2.0 release notes",
  },
] as const;

export const COMPETITOR_REFERENCE_COUNT = COMPETITOR_CAPABILITY_REFERENCES.length;
