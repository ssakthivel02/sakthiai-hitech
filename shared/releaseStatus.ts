/**
 * Pure helpers for the public release-status ledger (release/release-status.json).
 * Rules: unknown is never healthy; an observation older than its freshness window is stale and is treated as unknown;
 * a deployment matches the candidate only when both full commit ids are known and equal.
 */
export const RELEASE_LAYER_STATES = ["planned", "source_implemented", "ci_passed", "live_verified", "deployed", "blocked", "unknown"] as const;
export type ReleaseLayerState = (typeof RELEASE_LAYER_STATES)[number];

export const RELEASE_STATE_LABELS: Record<ReleaseLayerState, string> = {
  planned: "Planned",
  source_implemented: "Source implemented",
  ci_passed: "CI passed",
  live_verified: "Live verified",
  deployed: "Deployed",
  blocked: "Blocked",
  unknown: "Unknown (not healthy)",
};

/** Only live_verified and deployed are runtime evidence; nothing else may be presented as healthy. */
export function isRuntimeHealthy(state: ReleaseLayerState): boolean {
  return state === "live_verified" || state === "deployed";
}

export function normalizeLayerState(value: unknown): ReleaseLayerState {
  return typeof value === "string" && (RELEASE_LAYER_STATES as readonly string[]).includes(value) ? (value as ReleaseLayerState) : "unknown";
}

export type Freshness = { status: "fresh" | "stale" | "unknown"; ageDays: number | null };

export function evidenceFreshness(observedAt: unknown, freshnessDays: unknown, now: Date): Freshness {
  if (typeof observedAt !== "string") return { status: "unknown", ageDays: null };
  const at = Date.parse(observedAt);
  const window = typeof freshnessDays === "number" && Number.isFinite(freshnessDays) && freshnessDays > 0 ? freshnessDays : null;
  if (!Number.isFinite(at) || window === null) return { status: "unknown", ageDays: null };
  const ageDays = (now.getTime() - at) / 86_400_000;
  if (ageDays < -1 / 24) return { status: "unknown", ageDays: null }; // more than an hour in the future: not trustworthy
  return { status: ageDays > window ? "stale" : "fresh", ageDays: Math.max(0, Math.floor(ageDays)) };
}

/** A stale observation degrades to unknown; a fresh one keeps its recorded state. */
export function effectiveLayerState(state: unknown, freshness: Freshness): ReleaseLayerState {
  const normalized = normalizeLayerState(state);
  return freshness.status === "fresh" ? normalized : "unknown";
}

const FULL_SHA = /^[0-9a-f]{40}$/;

export type CommitComparison = "match" | "differs" | "unknown";

export function compareCommits(a: unknown, b: unknown): CommitComparison {
  if (typeof a !== "string" || typeof b !== "string") return "unknown";
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  if (!FULL_SHA.test(x) || !FULL_SHA.test(y)) return "unknown";
  return x === y ? "match" : "differs";
}

export function shortSha(value: unknown): string {
  return typeof value === "string" && FULL_SHA.test(value.trim().toLowerCase()) ? value.trim().slice(0, 7) : "unknown";
}
