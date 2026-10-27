import { describe, expect, it } from "vitest";
import { checkBetaProfile, type EnvLike } from "./betaProfile";

const good: EnvLike = {
  NODE_ENV: "production", SAKTHIAI_DEPLOY_ENV: "preview", JWT_SECRET: "x".repeat(40), DATABASE_URL: "mysql://u:p@h/db", DATABASE_EXPECTED_NAME: "db",
  AUTH_ALLOWED_SUBJECTS: "sub-1", RATE_LIMIT_STORE: "mysql", RATE_LIMIT_MAX_INSTANCES: "1",
  GATEWAY_ALLOW_EXTERNAL: "false", GATEWAY_ALLOW_METERED: "false",
};
const failing = (env: EnvLike, options = {}) => checkBetaProfile(env, options).findings.filter(f => f.level === "fail").map(f => f.variable);

describe("private-beta runtime profile", () => {
  it("accepts the intended posture", () => { expect(checkBetaProfile(good)).toEqual({ ok: true, findings: [] }); });
  it("requires an explicit deployment tier", () => {
    expect(failing({ ...good, SAKTHIAI_DEPLOY_ENV: "" })).toContain("SAKTHIAI_DEPLOY_ENV");
    expect(failing({ ...good, SAKTHIAI_DEPLOY_ENV: "staging" })).toContain("SAKTHIAI_DEPLOY_ENV");
    expect(checkBetaProfile({ ...good, SAKTHIAI_DEPLOY_ENV: "production" }).ok).toBe(true);
  });
  it("requires the shared rate-limit store and a valid instance ceiling", () => {
    expect(failing({ ...good, RATE_LIMIT_STORE: "" })).toContain("RATE_LIMIT_STORE");
    expect(failing({ ...good, RATE_LIMIT_STORE: "memory" })).toContain("RATE_LIMIT_STORE");
    expect(failing({ ...good, RATE_LIMIT_MAX_INSTANCES: "" })).toContain("RATE_LIMIT_MAX_INSTANCES");
    expect(failing({ ...good, RATE_LIMIT_MAX_INSTANCES: "0" })).toContain("RATE_LIMIT_MAX_INSTANCES");
    expect(failing({ ...good, RATE_LIMIT_MAX_INSTANCES: "many" })).toContain("RATE_LIMIT_MAX_INSTANCES");
  });
  it("refuses open signup and a missing allowlist", () => {
    expect(failing({ ...good, AUTH_OPEN_SIGNUP: "true" })).toContain("AUTH_OPEN_SIGNUP");
    expect(failing({ ...good, AUTH_ALLOWED_SUBJECTS: undefined })).toContain("AUTH_ALLOWED_SUBJECTS");
  });
  it("refuses uploads and paid Creator being switched on, and flags unused storage credentials", () => {
    expect(failing({ ...good, FILE_INGESTION_BACKEND_ENABLED: "true" })).toContain("FILE_INGESTION_BACKEND_ENABLED");
    expect(failing({ ...good, CREATOR_PAID_GENERATION_ENABLED: "true" })).toContain("CREATOR_PAID_GENERATION_ENABLED");
    expect(failing({ ...good, CREATOR_PAID_IMAGE_USERS: "1" })).toContain("CREATOR_PAID_IMAGE_USERS");
    const warned = checkBetaProfile({ ...good, STORAGE_BUCKET: "b" }).findings;
    expect(warned).toEqual([expect.objectContaining({ level: "warn", variable: "STORAGE_*" })]);
  });
  it("keeps Sentinel (incident investigation) off in the beta profile, and its absence is not a finding", () => {
    expect(failing({ ...good, SENTINEL_ENABLED: "true" })).toContain("SENTINEL_ENABLED");
    expect(failing({ ...good, SENTINEL_ENABLED: "TRUE" })).toContain("SENTINEL_ENABLED");
    for (const off of [undefined, "", "false", "0"]) expect(failing({ ...good, SENTINEL_ENABLED: off }), String(off)).not.toContain("SENTINEL_ENABLED");
  });
  it("pins the database name and requires Aiven CA trust material", () => {
    expect(failing({ ...good, DATABASE_EXPECTED_NAME: "other" })).toContain("DATABASE_EXPECTED_NAME");
    expect(failing({ ...good, DATABASE_URL: "postgres://u:p@h/db" })).toContain("DATABASE_URL");
    const aiven = { ...good, DATABASE_URL: "mysql://u:p@example.aivencloud.com/db" };
    expect(failing(aiven)).toContain("DATABASE_CA_CERT_B64");
    expect(checkBetaProfile({ ...aiven, DATABASE_CA_CERT_B64: "ZmFrZS1jYQ==" }).ok).toBe(true);
  });
  it("keeps hosted/metered models off outside an approved activation", () => {
    expect(failing({ ...good, GATEWAY_ALLOW_EXTERNAL: "true" })).toContain("GATEWAY_ALLOW_EXTERNAL");
    expect(failing({ ...good, GATEWAY_ALLOW_METERED: "true" })).toContain("GATEWAY_ALLOW_METERED");
    expect(failing({ ...good, LOCAL_LLM_API_URL: "https://api.sarvam.ai" })).toContain("LOCAL_LLM_API_URL");
  });
  it("an activation needs the durable store, explicit ceilings, a pinned profile and a key", () => {
    const base = { ...good, GATEWAY_ALLOW_EXTERNAL: "true", GATEWAY_ALLOW_METERED: "true" };
    const missing = failing(base, { modelActivation: true });
    for (const name of ["GATEWAY_STATE_STORE", "GATEWAY_EXTERNAL_MAX_COST_PER_DAY", "GATEWAY_COST_UNIT", "LLM_API_KEY", "LLM_ENDPOINT_PROFILE"]) expect(missing).toContain(name);
    const full = { ...base, GATEWAY_STATE_STORE: "mysql", GATEWAY_EXTERNAL_MAX_REQUESTS_PER_DAY: "200", GATEWAY_EXTERNAL_MAX_TOKENS_PER_DAY: "1000000", GATEWAY_EXTERNAL_MAX_COST_PER_DAY: "100", GATEWAY_COST_PER_1K_PROMPT_TOKENS: "0.015", GATEWAY_COST_PER_1K_COMPLETION_TOKENS: "0.06", GATEWAY_COST_UNIT: "INR", LLM_API_KEY: "k", LLM_ENDPOINT_PROFILE: "sarvam-chat" };
    expect(checkBetaProfile(full, { modelActivation: true }).ok).toBe(true);
  });
  it("never puts a value into a finding", () => {
    const text = JSON.stringify(checkBetaProfile({ ...good, JWT_SECRET: "short-SECRETVALUE", DATABASE_URL: "mysql://u:PASSWORDVALUE@h/db", RATE_LIMIT_STORE: "memory" }));
    expect(text).not.toMatch(/SECRETVALUE|PASSWORDVALUE/);
  });
});
