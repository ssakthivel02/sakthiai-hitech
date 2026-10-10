/**
 * Deployment tier for operational endpoints (/healthz, /releasez).
 *
 * NODE_ENV is the runtime build mode: `pnpm start` always sets it to "production", so it cannot
 * say which deployment this is. A preview must never present itself as production. The tier
 * comes only from an explicit SAKTHIAI_DEPLOY_ENV allowlist value; anything else is "unspecified".
 */
export const DEPLOYMENT_TIERS = ["local", "preview", "staging", "production"] as const;
export type DeploymentTier = (typeof DEPLOYMENT_TIERS)[number] | "unspecified";

type Env = Record<string, string | undefined>;

export function deploymentTier(env: Env = process.env): DeploymentTier {
  const normalized = env.SAKTHIAI_DEPLOY_ENV?.trim().toLowerCase();
  return (DEPLOYMENT_TIERS as readonly string[]).includes(normalized ?? "") ? (normalized as DeploymentTier) : "unspecified";
}

export function runtimeMode(env: Env = process.env): string {
  return env.NODE_ENV?.trim() || "unknown";
}
