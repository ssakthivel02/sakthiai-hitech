export const EXTERNAL_SPECIALISTS = ["claude", "gemini", "heygen", "manus"] as const;
export type ExternalSpecialistId = (typeof EXTERNAL_SPECIALISTS)[number];

export interface ExternalSpecialistContract {
  id: ExternalSpecialistId;
  role: string;
  primaryMission: string;
  allowed: readonly string[];
  prohibited: readonly string[];
  requiredReturn: readonly string[];
  spendPolicy: "no_spend" | "approval_before_spend";
  repoWritePolicy: "read_only" | "explicit_assignment_only";
}

const globalProhibited = [
  "Do not merge or close PR #7 or PR #25.",
  "Do not create a duplicate SakthiAI repository, branch, PR, dashboard, Render service or database lane.",
  "Do not modify production, DNS, Aiven, Render, DB schema/migrations, secrets, billing or paid providers without an explicit owner-authorised assignment.",
  "Do not expose secrets, credentials, private data or hidden chain-of-thought.",
  "Do not declare COMPLETE, PASS, PRODUCTION READY or competitor parity without linked evidence.",
  "Do not reimplement work already present in current main, PR #7 or PR #25; classify it as ALREADY_KNOWN instead.",
] as const;

const requiredReturn = [
  "Source Authority check with current date/time and exact references inspected.",
  "Findings classified as NEW, ALREADY_KNOWN, PASS, FAIL, BLOCKED or ACTION_REQUIRED.",
  "Evidence links/quotes or reproducible observations for every material claim.",
  "Mapped SakthiAI capability IDs/domains affected.",
  "Concrete delta only: what is missing, why it matters, and acceptance criteria.",
  "Collision check against PR #7 Creator/runtime lane and PR #25 Core Intelligence/master-scope lane.",
  "A final DO_NOT_DO list for anything that should remain untouched.",
] as const;

export const EXTERNAL_SPECIALIST_CONTRACTS: readonly ExternalSpecialistContract[] = [
  {
    id: "claude",
    role: "Architecture red-team and quality critic",
    primaryMission: "Stress-test SakthiAI architecture, security, agent design, evidence rules and implementation gaps without taking ownership of the product roadmap.",
    allowed: [
      "Read public/current project evidence supplied to it.",
      "Red-team architecture, threat model, auth, tenancy, memory, RAG, agents, tools and model routing.",
      "Compare public capabilities of frontier/open AI products using primary sources where possible.",
      "Produce patch plans, tests, acceptance criteria and risk-ranked deltas.",
    ],
    prohibited: globalProhibited,
    requiredReturn,
    spendPolicy: "no_spend",
    repoWritePolicy: "read_only",
  },
  {
    id: "gemini",
    role: "Multimodal, UX and Google-ecosystem specialist",
    primaryMission: "Audit live multimodal UX, mobile/voice/vision, image/video/audio workflows and Google model/tool interoperability, returning evidence-backed gaps only.",
    allowed: [
      "Review multimodal product flows and accessibility across desktop/mobile.",
      "Assess public Gemini/Veo/Imagen/voice capabilities and map portable product requirements.",
      "Design non-paid test matrices, prompts, fixtures and acceptance criteria.",
      "Review Tamil/English multilingual experience and media quality requirements.",
    ],
    prohibited: globalProhibited,
    requiredReturn,
    spendPolicy: "approval_before_spend",
    repoWritePolicy: "read_only",
  },
  {
    id: "heygen",
    role: "Avatar, dubbing and digital-human specialist",
    primaryMission: "Validate SakthiAI avatar/video requirements against real presenter, lip-sync, translation, dubbing and digital-human workflows without making HeyGen a mandatory dependency.",
    allowed: [
      "Audit avatar creation, talking-photo, presenter, lip-sync, dubbing, translation and voice workflow requirements.",
      "Create a bounded test plan using owner-supplied/authorised identity assets.",
      "Return quality criteria for identity consistency, Tamil pronunciation, lip sync, subtitles, framing and export.",
      "Generate a test only after explicit approval for the specific asset and any credits/spend involved.",
    ],
    prohibited: globalProhibited,
    requiredReturn,
    spendPolicy: "approval_before_spend",
    repoWritePolicy: "read_only",
  },
  {
    id: "manus",
    role: "Independent research and orchestration auditor",
    primaryMission: "Build evidence packs and broad public capability inventories, especially the 100+ AI model/product landscape, while returning structured findings to SakthiAI control rather than independently redefining or implementing the platform.",
    allowed: [
      "Research official/public sources for AI model/product capabilities, limits, deployment modes, pricing shape and open/self-hosted options.",
      "Build evidence tables and capability mappings for 100+ relevant model/product families in batches.",
      "Audit agent/computer-use/workflow patterns and identify portable design requirements.",
      "Return Markdown/CSV/JSON-style evidence suitable for ingestion into the SakthiAI capability dashboard.",
    ],
    prohibited: globalProhibited,
    requiredReturn,
    spendPolicy: "no_spend",
    repoWritePolicy: "read_only",
  },
] as const;

export function externalSpecialistContract(id: ExternalSpecialistId): ExternalSpecialistContract {
  const contract = EXTERNAL_SPECIALIST_CONTRACTS.find(item => item.id === id);
  if (!contract) throw new Error(`Unknown external specialist: ${id}`);
  return contract;
}
