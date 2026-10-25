// Contract for .github/workflows/production-db-setup.yml: the production database is reachable only through
// environment-scoped credentials, only from the exact approved commit, only for a confirmed database name, and only
// writes in migrate mode after the same guards the preview uses. Executes the configuration step for real.
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const wf = readFileSync(path.join(root, ".github/workflows/production-db-setup.yml"), "utf8");
const preview = readFileSync(path.join(root, ".github/workflows/preview-db-setup.yml"), "utf8");
const steps = wf.split(/\n      - name: /).slice(1);
const stepIndex = name => steps.findIndex(step => step.startsWith(name));
const runsIn = (step, mode) => {
  const m = /\n        if: (.+)\n/.exec(step);
  if (!m || m[1] === "always()") return true;
  const c = /^inputs\.mode == '(\w+)'$/.exec(m[1]);
  if (!c) throw new Error(`unrecognised condition ${m[1]}`);
  return c[1] === mode;
};
const temps = [];
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

describe("production-db-setup.yml: isolation from the preview", () => {
  it("maps each mode to its own production environment", () => {
    const m = /\n    environment: \$\{\{ inputs\.mode == '(\w+)' && '([\w-]+)' \|\| '([\w-]+)' \}\}\n/.exec(wf);
    expect(m).not.toBeNull();
    expect([m[1], m[2], m[3]]).toEqual(["migrate", "sakthiai-production-db-migrate", "sakthiai-production-db-inspect"]);
  });

  it("reads only production environment secrets, bound once at job level after the environment", () => {
    expect([...new Set(wf.match(/secrets\.[A-Z0-9_]+/g))].sort()).toEqual(["secrets.SAKTHIAI_PRODUCTION_DB_CA_B64", "secrets.SAKTHIAI_PRODUCTION_DB_URL"]);
    for (const step of steps) expect(step).not.toMatch(/secrets\./);
    expect(wf.indexOf("environment:")).toBeLessThan(wf.indexOf("secrets.SAKTHIAI_PRODUCTION_DB_URL"));
    expect(wf).not.toMatch(/SAKTHIAI_PREVIEW|sakthiai_preview|sakthiai-preview-db/);
    expect(wf).toMatch(/\n      DATABASE_EXPECTED_NAME: sakthiai_production\n/);
    expect(wf).toMatch(/\n      MIGRATION_REPORT_PREFIX: production-migration\n/);
  });

  it("has its own serialisation group and is dispatch-only", () => {
    expect(wf).toMatch(/\nconcurrency:\n\s+group: sakthiai-production-db\n\s+cancel-in-progress: false\n/);
    expect(preview).toMatch(/group: sakthiai-preview-db\n/);
    expect(wf).toMatch(/\non:\n  workflow_dispatch:\n/);
    expect(wf).not.toMatch(/\n  (push|pull_request|schedule|workflow_run):/);
    expect(wf).not.toMatch(/continue-on-error/);
  });
});

describe("production-db-setup.yml: guard sequence", () => {
  it("defaults to inspect; every database-writing step runs only in migrate mode", () => {
    expect(wf).toMatch(/mode:[\s\S]*type: choice[\s\S]*options: \[inspect, migrate\][\s\S]*default: inspect/);
    const writers = steps.filter(step => /pnpm db:push|db:backfill-search-text/.test(step));
    expect(writers.length).toBe(3);
    for (const step of writers) { expect(runsIn(step, "inspect")).toBe(false); expect(runsIn(step, "migrate")).toBe(true); }
    expect(runsIn(steps[stepIndex("Post-migration")], "inspect")).toBe(false);
  });

  it("runs configuration, target, attest, grants and pre guards unconditionally, in order, before any write", () => {
    const order = ["Require environment-scoped production database configuration", "Validate production Aiven MySQL target", "Require a valid owner-attested", "Database principal privileges", "Pre-migration journal", "Apply production schema"].map(stepIndex);
    expect(order.every(i => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(order[0]).toBe(1); // straight after checkout
    for (const i of order.slice(0, 5)) expect(steps[i]).not.toMatch(/\n        if: /);
    expect(steps[order[2]]).toMatch(/RECOVERY_POINT: \$\{\{ inputs\.recovery_point \}\}\n\s+run: node scripts\/preview-migration-guard\.mjs attest/);
    expect(steps[order[4]]).toMatch(/RECOVERY_POINT: \$\{\{ inputs\.recovery_point \}\}\n\s+run: node scripts\/preview-migration-guard\.mjs pre/);
    expect(wf).toMatch(/pnpm db:push\n\s+node scripts\/preview-migration-guard\.mjs rerun/);
  });

  it("keeps credentials away from dependency install and typecheck; only the evidence upload runs after a failure", () => {
    for (const name of ["Install dependencies", "Typecheck"]) expect(steps[stepIndex(name)], name).toMatch(/\n        env:\n          DATABASE_URL: ""\n          DATABASE_CA_CERT_B64: ""\n/);
    for (const step of steps.filter(step => /if: always\(\)|if: failure\(\)/.test(step))) expect(step).toMatch(/^Upload production migration evidence/);
  });

  it("never interpolates dispatch inputs into a shell script (inputs reach scripts only through env)", () => {
    for (const step of steps) {
      const run = step.split("\n        run: ")[1] ?? "";
      expect(run, step.split("\n")[0]).not.toMatch(/\$\{\{\s*inputs\./);
    }
  });
});

describe("production-db-setup.yml: configuration step, executed", () => {
  const block = steps[stepIndex("Require environment-scoped production database configuration")];
  const script = block.split("\n        run: |\n")[1].split("\n").filter(l => l.startsWith("          ") || l === "").map(l => l.slice(10)).join("\n");
  const repo = mkdtempSync(path.join(os.tmpdir(), "prod-db-wf-"));
  temps.push(repo);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", "x"], { cwd: repo });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  const run = env => spawnSync("bash", ["-c", script], { cwd: repo, env: { PATH: process.env.PATH, ...env }, encoding: "utf8" });
  const full = {
    DATABASE_URL: "mysql://migrator:pw-secret@h.aivencloud.com:1/sakthiai_production", DATABASE_CA_CERT_B64: "Y2E=", DATABASE_EXPECTED_NAME: "sakthiai_production",
    MIGRATION_DB_ROLE: "inspect", ENVIRONMENT_DB_ROLE: "inspect", APPROVED_COMMIT: head, CONFIRM_DATABASE: "sakthiai_production",
  };

  it("passes only with matching role, exact approved commit, confirmed database and both credentials", () => {
    expect(script).toMatch(/^set -euo pipefail/);
    expect(run(full).status).toBe(0);
    expect(run({ ...full, MIGRATION_DB_ROLE: "migrate", ENVIRONMENT_DB_ROLE: "migrate" }).status).toBe(0);
    const refused = {
      "role mismatch": { ...full, MIGRATION_DB_ROLE: "migrate" },
      "environment variable missing": { ...full, ENVIRONMENT_DB_ROLE: undefined },
      "unknown role": { ...full, MIGRATION_DB_ROLE: "drop", ENVIRONMENT_DB_ROLE: "drop" },
      "different commit": { ...full, APPROVED_COMMIT: "0".repeat(40) },
      "short commit": { ...full, APPROVED_COMMIT: head.slice(0, 7) },
      "uppercase commit": { ...full, APPROVED_COMMIT: head.toUpperCase() },
      "commit with shell metacharacters": { ...full, APPROVED_COMMIT: `${head}; echo pwned` },
      "unconfirmed database": { ...full, CONFIRM_DATABASE: "" },
      "preview confirmed instead": { ...full, CONFIRM_DATABASE: "sakthiai_preview" },
      "url missing": { ...full, DATABASE_URL: undefined },
      "ca missing": { ...full, DATABASE_CA_CERT_B64: undefined },
    };
    for (const [label, env] of Object.entries(refused)) {
      const clean = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined));
      const r = run(clean);
      expect(r.status, label).not.toBe(0);
      expect(r.stdout + r.stderr, label).not.toMatch(/pw-secret/);
      expect(r.stdout + r.stderr, label).not.toMatch(/pwned\n/);
    }
  });
});

describe("guard evidence naming", () => {
  it("writes production-migration-*.json and labels its output when MIGRATION_REPORT_PREFIX is set; preview default unchanged", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "prod-guard-"));
    temps.push(dir);
    const guard = path.join(root, "scripts/preview-migration-guard.mjs");
    const prod = spawnSync("node", [guard, "attest"], { cwd: dir, env: { PATH: process.env.PATH, RECOVERY_POINT: "2026-10-01T00:00:00Z", MIGRATION_REPORT_PREFIX: "production-migration" }, encoding: "utf8" });
    expect(prod.status).toBe(0);
    expect(prod.stdout).toMatch(/^PRODUCTION_MIGRATION_ATTEST PASS/);
    expect(existsSync(path.join(dir, "reports/staging/production-migration-attest.json"))).toBe(true);
    const prev = spawnSync("node", [guard, "attest"], { cwd: dir, env: { PATH: process.env.PATH, RECOVERY_POINT: "2026-10-01T00:00:00Z" }, encoding: "utf8" });
    expect(prev.stdout).toMatch(/^PREVIEW_MIGRATION_ATTEST PASS/);
    expect(existsSync(path.join(dir, "reports/staging/preview-migration-attest.json"))).toBe(true);
    const bad = spawnSync("node", [guard, "attest"], { cwd: dir, env: { PATH: process.env.PATH, RECOVERY_POINT: "2026-10-01T00:00:00Z", MIGRATION_REPORT_PREFIX: "../escape" }, encoding: "utf8" });
    expect(bad.status).not.toBe(0);
    expect(existsSync(path.join(dir, "reports/escape-attest.json"))).toBe(false);
  });
});
