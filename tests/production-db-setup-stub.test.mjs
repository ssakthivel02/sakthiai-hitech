import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/**
 * The initial main-branch registration is deliberately a refusal stub.
 * After integration PR #29 is promoted, the guarded workflow replaces it.
 * This regression contract must validate BOTH states without accepting an
 * unguarded production database writer.
 */
const workflow = readFileSync(new URL('../.github/workflows/production-db-setup.yml', import.meta.url), 'utf8');
const code = workflow.split('\n').filter(line => !line.trim().startsWith('#')).join('\n');
const isStub = /^  refuse:$/m.test(code);

describe('production-db-setup has fail-closed registration or guarded operational implementation', () => {
  it('retains the manual-only identity, inputs, permissions and concurrency', () => {
    expect(code).toMatch(/^name: SakthiAI Production DB Setup$/m);
    expect(code).toMatch(/^on:\n  workflow_dispatch:\n    inputs:/m);
    expect(code).not.toMatch(/^\s+(push|pull_request|pull_request_target|schedule|workflow_run|repository_dispatch):/m);
    for (const input of ['mode', 'recovery_point', 'approved_commit', 'confirm_database']) {
      expect(code).toMatch(new RegExp('^      ' + input + ':$', 'm'));
    }
    expect(code).toMatch(/^permissions:\n  contents: read$/m);
    expect(code).toMatch(/^concurrency:\n  group: sakthiai-production-db\n  cancel-in-progress: false$/m);
  });

  it('never accepts an unidentified third workflow state', () => {
    const jobs = code.split(/^jobs:$/m)[1];
    expect(jobs).toBeTruthy();
    expect(jobs.match(/^  [a-zA-Z0-9_-]+:$/gm)).toEqual(isStub ? ['  refuse:'] : ['  bind:', '  migrate:']);
  });

  it('default-branch registration cannot read credentials or write to a database', () => {
    if (!isStub) return;
    expect(code).not.toMatch(/secrets\.|\bvars\./);
    expect(code).not.toMatch(/^\s+environment:/m);
    expect(code).not.toMatch(/actions\/checkout|db:push|drizzle-kit|pnpm|npm |node |DATABASE_URL/);
    expect(code.match(/^      - name:/gm)).toHaveLength(1);
    const body = code.split('run: |')[1];
    expect(body).toBeTruthy();
    const script = body.split('\n').filter(line => line.startsWith('          ')).map(line => line.slice(10)).join('\n');
    for (const mode of ['inspect', 'migrate']) {
      const run = spawnSync('bash', ['-c', script], {
        env: { PATH: process.env.PATH, INPUT_MODE: mode }, encoding: 'utf8',
      });
      expect(run.status, run.stdout + run.stderr).toBe(1);
      expect(run.stdout).toContain('::error::');
      expect(run.stdout).toContain('integration/pr7-pr25-runtime-qualification-20260925');
    }
  });

  it('guarded replacement requires exact SHA, production database, TLS and mode-specific privileges', () => {
    if (isStub) return;
    expect(code).toMatch(/^  bind:$/m);
    expect(code).toMatch(/^  migrate:\n    needs: bind$/m);
    const bind = code.split(/^  bind:$/m)[1]?.split(/^  migrate:$/m)[0] ?? '';
    expect(bind).toContain('APPROVED_COMMIT:');
    expect(bind).toContain('DISPATCHED_COMMIT:');
    expect(bind).toContain('CONFIRM_DATABASE:');
    expect(bind).toContain('sakthiai_production');
    expect(bind).not.toMatch(/secrets\.|\bvars\.|environment:|DATABASE_URL|actions\/checkout|db:push|pnpm|npm /);
    expect(bind).toContain('exit 1');
    expect(code).toContain("sakthiai-production-db-migrate");
    expect(code).toContain("sakthiai-production-db-inspect");
    expect(code).toContain("DATABASE_EXPECTED_NAME: sakthiai_production");
    expect(code).toContain("SAKTHIAI_PRODUCTION_DB_URL");
    expect(code).toContain("SAKTHIAI_PRODUCTION_DB_CA_B64");
    expect(code).toContain("ENVIRONMENT_DB_ROLE:");
    expect(code).toContain("APPROVED_COMMIT:");
    expect(code).toContain("CONFIRM_DATABASE:");
    expect(code).toContain("git rev-parse HEAD");
    expect(code).toContain("DATABASE_EXPECTED_NAME");
    expect(code).toContain("preview-migration-guard.mjs grants");
    expect(code).toContain("preview-migration-guard.mjs pre");
    expect(code).toContain("recovery_point:");
    expect(code).toContain("if: inputs.mode == 'migrate'");
    expect(code).toContain("pnpm db:push");
    expect(code).toContain("preview-migration-guard.mjs post");
    expect(code).toContain("preview-migration-guard.mjs rerun");
    expect(code).not.toMatch(/^\s+(?:pull_request_target|schedule):/m);
    const ensureRole = code.indexOf('Environment variable SAKTHIAI_PRODUCTION_DB_ROLE');
    const writing = code.indexOf('run: pnpm db:push');
    expect(ensureRole).toBeGreaterThan(0);
    expect(writing).toBeGreaterThan(ensureRole);
  });
});
