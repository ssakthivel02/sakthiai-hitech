import type { CreatorMediaKind, CreatorMediaRequest } from "./types";

/**
 * Creator paid-generation policy (P0 spend security). Pure and environment-driven; fails closed.
 *
 * - Feature switch `CREATOR_PAID_GENERATION_ENABLED` must equal exactly "true"; anything else is OFF.
 * - Authorization: administrators, or an exact openId match in the kind-specific allowlist
 *   (`CREATOR_PAID_IMAGE_USERS`, `CREATOR_PAID_VIDEO_USERS`, comma-separated). Image permission never implies video.
 * - Every model must have a server-side price in `CREATOR_MODEL_COSTS` (JSON: model → {perGeneration?, perSecond?}).
 *   No prices are hard-coded: an unpriced model cannot be budgeted and is denied.
 * - All six daily limits (global / workspace / user × generations / cost) are required while enabled.
 */
export type CreatorPaidKind = "IMAGE" | "VIDEO" | "SPEECH" | "AVATAR_VIDEO";

export type CreatorSpendLimits = {
  globalGenerations: number;
  globalCost: number;
  workspaceGenerations: number;
  workspaceCost: number;
  userGenerations: number;
  userCost: number;
};

export type CreatorModelCost = { perGeneration?: number; perSecond?: number; perThousandChars?: number };

export type CreatorPaidConfig = {
  imageUsers: ReadonlySet<string>;
  videoUsers: ReadonlySet<string>;
  speechUsers: ReadonlySet<string>;
  avatarUsers: ReadonlySet<string>;
  costs: ReadonlyMap<string, CreatorModelCost>;
  limits: CreatorSpendLimits;
};

export type CreatorPaidConfigResult =
  | { ok: true; config: CreatorPaidConfig }
  | { ok: false; code: "CREATOR_PAID_GENERATION_DISABLED" }
  | { ok: false; code: "CREATOR_SPEND_POLICY_INVALID"; detail: string };

type Env = Record<string, string | undefined>;

const LIMIT_VARS: ReadonlyArray<[keyof CreatorSpendLimits, string]> = [
  ["globalGenerations", "CREATOR_GLOBAL_MAX_GENERATIONS_PER_DAY"],
  ["globalCost", "CREATOR_GLOBAL_MAX_COST_PER_DAY"],
  ["workspaceGenerations", "CREATOR_WORKSPACE_MAX_GENERATIONS_PER_DAY"],
  ["workspaceCost", "CREATOR_WORKSPACE_MAX_COST_PER_DAY"],
  ["userGenerations", "CREATOR_USER_MAX_GENERATIONS_PER_DAY"],
  ["userCost", "CREATOR_USER_MAX_COST_PER_DAY"],
];

/** Video cost is charged for the requested duration; a missing duration is charged at the maximum. */
export const CREATOR_MAX_VIDEO_SECONDS = 8;
/** Largest value the ledger's DECIMAL(18,6) columns hold safely. */
const MAX_AMOUNT = 1_000_000_000;

function positive(raw: string | undefined, integer: boolean): number | undefined {
  const text = raw?.trim();
  if (!text || !/^\d+(\.\d+)?$/.test(text)) return undefined;
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0 || value > MAX_AMOUNT) return undefined;
  if (integer && !Number.isInteger(value)) return undefined;
  return value;
}

function allowlist(raw: string | undefined): ReadonlySet<string> {
  return new Set((raw ?? "").split(",").map(entry => entry.trim()).filter(Boolean));
}

function amount(value: unknown): number | undefined | "invalid" {
  if (value === undefined) return undefined;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_AMOUNT ? value : "invalid";
}

function parseCosts(raw: string | undefined): ReadonlyMap<string, CreatorModelCost> | string {
  if (!raw?.trim()) return "CREATOR_MODEL_COSTS missing";
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "CREATOR_MODEL_COSTS not JSON";
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "CREATOR_MODEL_COSTS must be an object";
  const costs = new Map<string, CreatorModelCost>();
  for (const [model, entry] of Object.entries(parsed as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return `CREATOR_MODEL_COSTS[${model}] invalid`;
    const keys = Object.keys(entry);
    if (keys.some(key => key !== "perGeneration" && key !== "perSecond" && key !== "perThousandChars")) return `CREATOR_MODEL_COSTS[${model}] unknown field`;
    const perGeneration = amount((entry as Record<string, unknown>).perGeneration);
    const perSecond = amount((entry as Record<string, unknown>).perSecond);
    const perThousandChars = amount((entry as Record<string, unknown>).perThousandChars);
    if (perGeneration === "invalid" || perSecond === "invalid" || perThousandChars === "invalid") return `CREATOR_MODEL_COSTS[${model}] invalid amount`;
    if (perGeneration === undefined && perSecond === undefined && perThousandChars === undefined) return `CREATOR_MODEL_COSTS[${model}] has no price`;
    costs.set(model, { perGeneration, perSecond, perThousandChars });
  }
  if (costs.size === 0) return "CREATOR_MODEL_COSTS empty";
  return costs;
}

/** Allowlists only; readable even when the spend policy is incomplete, so authorization is decided first. */
export type CreatorPaidAllowlists = Pick<CreatorPaidConfig, "imageUsers" | "videoUsers" | "speechUsers" | "avatarUsers">;

export function readCreatorPaidAllowlists(env: Env = process.env): CreatorPaidAllowlists {
  return {
    imageUsers: allowlist(env.CREATOR_PAID_IMAGE_USERS),
    videoUsers: allowlist(env.CREATOR_PAID_VIDEO_USERS),
    speechUsers: allowlist(env.CREATOR_PAID_SPEECH_USERS),
    avatarUsers: allowlist(env.CREATOR_PAID_AVATAR_USERS),
  };
}

export function readCreatorPaidConfig(env: Env = process.env): CreatorPaidConfigResult {
  if (env.CREATOR_PAID_GENERATION_ENABLED !== "true") return { ok: false, code: "CREATOR_PAID_GENERATION_DISABLED" };
  const costs = parseCosts(env.CREATOR_MODEL_COSTS);
  if (typeof costs === "string") return { ok: false, code: "CREATOR_SPEND_POLICY_INVALID", detail: costs };
  const limits = {} as CreatorSpendLimits;
  for (const [key, name] of LIMIT_VARS) {
    const value = positive(env[name], key.endsWith("Generations"));
    if (value === undefined) return { ok: false, code: "CREATOR_SPEND_POLICY_INVALID", detail: `${name} missing or invalid` };
    limits[key] = value;
  }
  return {
    ok: true,
    config: { ...readCreatorPaidAllowlists(env), costs, limits },
  };
}

export function paidKindOf(kind: CreatorMediaKind | string): CreatorPaidKind {
  if (kind === "IMAGE" || kind === "IMAGE_EDIT") return "IMAGE";
  if (kind === "VIDEO" || kind === "VIDEO_EXTENSION") return "VIDEO";
  if (kind === "SPEECH") return "SPEECH";
  if (kind === "AVATAR_VIDEO") return "AVATAR_VIDEO";
  // Unknown kinds are treated as the most expensive class.
  return "VIDEO";
}

export function isAuthorizedForPaidKind(user: { role?: string | null; openId?: string | null }, kind: CreatorPaidKind, config: Partial<CreatorPaidAllowlists>): boolean {
  if (user.role === "admin") return true;
  if (!user.openId) return false;
  // Each kind has its own allowlist: no permission implies another (image never implies video, speech never avatar).
  const list = kind === "IMAGE" ? config.imageUsers : kind === "VIDEO" ? config.videoUsers : kind === "SPEECH" ? config.speechUsers : config.avatarUsers;
  return list?.has(user.openId) ?? false;
}

/** Server-side cost estimate. `undefined` = model is not priced (deny). Rounded up to 6 decimals (ledger precision). */
export function estimateCreatorCost(config: CreatorPaidConfig, model: string, request: CreatorMediaRequest): number | undefined {
  const price = config.costs.get(model);
  if (!price) return undefined;
  let cost = price.perGeneration ?? 0;
  if (price.perSecond !== undefined) {
    let seconds = 1;
    if (request.kind === "VIDEO" || request.kind === "VIDEO_EXTENSION") seconds = request.durationSeconds ?? CREATOR_MAX_VIDEO_SECONDS;
    else if (request.kind === "AVATAR_VIDEO") {
      // Charged for the driving audio's duration, rounded up; an invalid duration cannot be budgeted.
      if (!Number.isFinite(request.expectedSeconds) || request.expectedSeconds <= 0) return undefined;
      seconds = Math.ceil(request.expectedSeconds);
    }
    cost += price.perSecond * seconds;
  }
  if (price.perThousandChars !== undefined) {
    if (request.kind !== "SPEECH") return undefined;
    cost += price.perThousandChars * (request.prompt.length / 1000);
  }
  return Math.ceil(cost * 1_000_000 - 1e-6) / 1_000_000;
}
