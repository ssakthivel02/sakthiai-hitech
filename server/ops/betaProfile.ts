/**
 * The private-beta runtime profile as a checkable contract. Pure: takes an environment-like object, returns findings.
 * Used by scripts/check-beta-profile.mjs before a deployment's settings are applied. It reads NO secret values into its
 * output: findings name variables, never their contents.
 *
 * Findings are "fail" (must fix before the beta serves anyone) or "warn" (acceptable only knowingly).
 */
export type EnvLike = Record<string, string | undefined>;
export type ProfileFinding = { level: "fail" | "warn"; variable: string; message: string };
export type ProfileOptions = {
  /** Set only while an owner-approved model activation is in progress: allows hosted-model settings to be ON. */
  modelActivation?: boolean;
};

const on = (value: string | undefined) => value?.trim().toLowerCase() === "true";
const set = (value: string | undefined) => typeof value === "string" && value.trim().length > 0;

export function checkBetaProfile(env: EnvLike, options: ProfileOptions = {}): { ok: boolean; findings: ProfileFinding[] } {
  const f: ProfileFinding[] = [];
  const fail = (variable: string, message: string) => f.push({ level: "fail", variable, message });
  const warn = (variable: string, message: string) => f.push({ level: "warn", variable, message });

  if (env.NODE_ENV !== "production") fail("NODE_ENV", "must be production for a deployed beta");
  const deployEnv = (env.SAKTHIAI_DEPLOY_ENV ?? "").trim().toLowerCase();
  if (!["preview", "production"].includes(deployEnv)) fail("SAKTHIAI_DEPLOY_ENV", "must be explicitly preview or production");


  // Access: an explicit allowlist, never open signup, never an unset policy (which is "closed" in production, i.e. nobody can sign in).
  if (on(env.AUTH_OPEN_SIGNUP)) fail("AUTH_OPEN_SIGNUP", "open signup must be off in the private beta");
  if (![env.AUTH_ALLOWED_SUBJECTS, env.AUTH_ALLOWED_EMAILS, env.OWNER_OPEN_ID].some(set)) fail("AUTH_ALLOWED_SUBJECTS", "no allowlist: set AUTH_ALLOWED_SUBJECTS and/or AUTH_ALLOWED_EMAILS (and OWNER_OPEN_ID)");

  // Uploads and Creator stay OFF.
  if (set(env.FILE_INGESTION_BACKEND_ENABLED) && env.FILE_INGESTION_BACKEND_ENABLED !== "false") fail("FILE_INGESTION_BACKEND_ENABLED", "file uploads must be off in the beta (leave unset)");
  if (on(env.CREATOR_PAID_GENERATION_ENABLED)) fail("CREATOR_PAID_GENERATION_ENABLED", "paid Creator generation must stay off");
  for (const name of ["CREATOR_PAID_IMAGE_USERS", "CREATOR_PAID_VIDEO_USERS"]) if (set(env[name])) fail(name, "paid Creator user lists must be empty");
  if (["STORAGE_BUCKET", "STORAGE_ACCESS_KEY_ID", "STORAGE_SECRET_ACCESS_KEY"].some(name => set(env[name]))) warn("STORAGE_*", "object storage is not used by the enabled beta paths; remove it to keep the credential surface minimal");

  // Shared, fail-closed request limits.
  if ((env.RATE_LIMIT_STORE ?? "").trim().toLowerCase() !== "mysql") fail("RATE_LIMIT_STORE", "must be mysql (shared counters; costly routes refuse when the counter is unavailable)");
  const maxInstancesText = (env.RATE_LIMIT_MAX_INSTANCES ?? "").trim();
  if (!/^\d+$/.test(maxInstancesText) || Number(maxInstancesText) < 1) {
    fail("RATE_LIMIT_MAX_INSTANCES", "must be an explicit positive integer instance ceiling");
  }

  // Data store: pin the intended database and require trusted CA material for the approved managed Aiven host.
  if (!set(env.DATABASE_URL)) {
    fail("DATABASE_URL", "not set");
  } else {
    try {
      const databaseUrl = new URL(env.DATABASE_URL!);
      if (databaseUrl.protocol !== "mysql:") fail("DATABASE_URL", "must use mysql://");
      const databaseName = decodeURIComponent(databaseUrl.pathname.replace(/^\//, ""));
      if (set(env.DATABASE_EXPECTED_NAME) && databaseName !== env.DATABASE_EXPECTED_NAME) {
        fail("DATABASE_EXPECTED_NAME", "does not match the database named by DATABASE_URL");
      }
      if (databaseUrl.hostname.endsWith(".aivencloud.com") && !set(env.DATABASE_CA_CERT_B64)) {
        fail("DATABASE_CA_CERT_B64", "required for the managed Aiven database TLS trust chain");
      }
    } catch {
      fail("DATABASE_URL", "must be a valid mysql:// URL");
    }
  }
  if (!set(env.DATABASE_EXPECTED_NAME)) fail("DATABASE_EXPECTED_NAME", "not set: the connection must be pinned to the intended database");
  if (!set(env.JWT_SECRET) || (env.JWT_SECRET?.length ?? 0) < 32) fail("JWT_SECRET", "missing or shorter than 32 characters");

  // Model: hosted/metered is OFF until an owner-approved activation.
  const hosted = set(env.LLM_API_URL);
  const external = on(env.GATEWAY_ALLOW_EXTERNAL), metered = on(env.GATEWAY_ALLOW_METERED);
  if (!options.modelActivation) {
    if (external) fail("GATEWAY_ALLOW_EXTERNAL", "hosted models must stay disabled until an approved activation");
    if (metered) fail("GATEWAY_ALLOW_METERED", "metered models must stay disabled until an approved activation");
    if (hosted && !external) warn("LLM_API_URL", "a hosted model is configured but disabled; chat will report the model as unavailable until it is activated");
  } else {
    if (!external || !metered) fail("GATEWAY_ALLOW_EXTERNAL", "activation requires GATEWAY_ALLOW_EXTERNAL=true and GATEWAY_ALLOW_METERED=true");
    if ((env.GATEWAY_STATE_STORE ?? "").trim().toLowerCase() !== "mysql") fail("GATEWAY_STATE_STORE", "activation requires mysql so the spend ceiling survives restarts");
    for (const name of ["GATEWAY_EXTERNAL_MAX_REQUESTS_PER_DAY", "GATEWAY_EXTERNAL_MAX_TOKENS_PER_DAY", "GATEWAY_EXTERNAL_MAX_COST_PER_DAY", "GATEWAY_COST_PER_1K_PROMPT_TOKENS", "GATEWAY_COST_PER_1K_COMPLETION_TOKENS", "GATEWAY_COST_UNIT"]) if (!set(env[name])) fail(name, "activation requires an explicit ceiling and rate");
    if (!set(env.LLM_API_KEY)) fail("LLM_API_KEY", "not set");
    if (!set(env.LLM_ENDPOINT_PROFILE)) fail("LLM_ENDPOINT_PROFILE", "not set: pin the endpoint profile (e.g. sarvam-chat)");
  }
  if (set(env.LOCAL_LLM_API_URL) && /sarvam|openai|anthropic|googleapis/i.test(env.LOCAL_LLM_API_URL ?? "")) fail("LOCAL_LLM_API_URL", "a hosted provider must use LLM_*, never the local slot");

  if (on(env.TASK_WORKER_ENABLED)) warn("TASK_WORKER_ENABLED", "background tasks are outside the chat-and-projects beta scope");
  return { ok: !f.some(x => x.level === "fail"), findings: f };
}
