import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(new URL('../.github/workflows/production-db-setup.yml', import.meta.url), 'utf8');
const code = workflow.split('\n').filter(line => !line.trim().startsWith('#')).join('\n');
const bind = code.split(/^  bind:$/m)[1]?.split(/^  migrate:$/m)[0] ?? '';
const migrate = code.split(/^  migrate:$/m)[1] ?? '';
const runPart = bind.split('run: |')[1] ?? '';
const script = runPart.split('\n').filter(line => line.startsWith('          '))
  .map(line => line.slice(10)).join('\n');
const SHA = '0123456789abcdef0123456789abcdef01234567';

function verify(approved, dispatched, mode = 'inspect', db = 'sakthiai_production') {
  return spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      APPROVED_COMMIT: approved,
      DISPATCHED_COMMIT: dispatched,
      DISPATCH_MODE: mode,
      CONFIRM_DATABASE: db,
    },
  });
}

describe('production DB workflow: bind before protected secrets', () => {
  it('uses manual-only dispatch, read-only permissions and one serial group', () => {
    expect(code).toMatch(/^name: SakthiAI Production DB Setup$/m);
    expect(code).toMatch(/^on:\n  workflow_dispatch:\n    inputs:/m);
    expect(code).not.toMatch(/^\s+(push|pull_request|pull_request_target|schedule|workflow_run|repository_dispatch):/m);
    expect(code).toMatch(/^permissions:\n  contents: read$/m);
    expect(code).toMatch(/^concurrency:\n  group: sakthiai-production-db\n  cancel-in-progress: false$/m);
    expect(code.split(/^jobs:$/m)[1].match(/^  [a-zA-Z0-9_-]+:$/gm)).toEqual(['  bind:', '  migrate:']);
    expect(code).toMatch(/^  migrate:\n    needs: bind$/m);
  });

  it('does not expose a protected environment, any secret, checkout or network activity to bind', () => {
    expect(bind).toContain('APPROVED_COMMIT:');
    expect(bind).toContain('DISPATCHED_COMMIT:');
    expect(bind).toContain('CONFIRM_DATABASE:');
    expect(bind).toContain('DISPATCH_MODE:');
    expect(bind).not.toMatch(/\bsecrets\.|\bvars\.|\benvironment:|DATABASE_URL|actions\/checkout|\bcurl\b|\bwget\b|db:push|pnpm |npm /);
    expect(migrate).toContain('environment:');
    expect(migrate).toContain('SAKTHIAI_PRODUCTION_DB_URL');
    expect(migrate).toContain('SAKTHIAI_PRODUCTION_DB_CA_B64');
    expect(migrate).toContain('MIGRATION_DB_ROLE:');
  });

  it('rejects an incorrect SHA before environment access', () => {
    const result = verify(SHA, 'fedcba9876543210fedcba9876543210fedcba98');
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('::error::');
  });

  it('rejects malformed or missing approved SHA', () => {
    for (const value of ['abc', '', SHA.toUpperCase()]) {
      const result = verify(value, SHA);
      expect(result.status).toBe(1);
    }
  });

  it('rejects wrong database target and unsupported mode', () => {
    for (const [mode, db] of [['inspect', 'sakthiai_preview'], ['migrate', 'other'], ['write', 'sakthiai_production']]) {
      const result = verify(SHA, SHA, mode, db);
      expect(result.status).toBe(1);
    }
  });

  it('passes a precisely matching approved SHA and database in either supported mode', () => {
    for (const mode of ['inspect', 'migrate']) {
      const result = verify(SHA, SHA, mode);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('Secret-free production DB binding PASS');
    }
  });

  it('rechecks target and role inside the guarded job; only migrate mode can write', () => {
    expect(migrate).toContain('git rev-parse HEAD');
    expect(migrate).toContain('CONFIRM_DATABASE');
    expect(migrate).toContain('sakthiai_production');
    expect(migrate).toContain('SAKTHIAI_PRODUCTION_DB_ROLE');
    expect(migrate).toContain('preview-migration-guard.mjs grants');
    expect(migrate).toContain('preview-migration-guard.mjs pre');
    expect(migrate).toContain("if: inputs.mode == 'migrate'");
    expect(migrate).toContain('pnpm db:push');
    expect(migrate).toContain('preview-migration-guard.mjs post');
    expect(migrate).toContain('preview-migration-guard.mjs rerun');
  });
});
