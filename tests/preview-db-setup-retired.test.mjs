import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/**
 * PR #32 registered a default-branch refusal stub for the guarded preview DB
 * workflow on PR #29. The promoted guarded workflow must also pass this suite,
 * while an unguarded writer or third workflow shape must be rejected.
 */
const workflow = readFileSync(new URL('../.github/workflows/preview-db-setup.yml', import.meta.url), 'utf8');
const code = workflow.split('\n').filter(line => !line.trim().startsWith('#')).join('\n');
const isStub = /^  refuse:$/m.test(code);

describe('preview DB registration and guarded replacement', () => {
  it('retains manual-only dispatch, inputs, token permissions and concurrency', () => {
    expect(code).toMatch(/^name: SakthiAI Preview DB Setup$/m);
    expect(code).toMatch(/^on:\n  workflow_dispatch:\n    inputs:/m);
    expect(code).not.toMatch(/^\s+(push|pull_request|pull_request_target|schedule|workflow_run|repository_dispatch):/m);
    for (const input of ['mode', 'recovery_point']) {
      expect(code).toMatch(new RegExp('^      ' + input + ':$', 'm'));
    }
    expect(code).toMatch(/^permissions:\n  contents: read$/m);
    expect(code).toMatch(/^concurrency:\n  group: sakthiai-preview-db\n  cancel-in-progress: false$/m);
  });

  it('recognizes only the refusal stub or the guarded bind/migrate workflow', () => {
    const jobs = code.split(/^jobs:$/m)[1];
    expect(jobs).toBeTruthy();
    expect(jobs.match(/^  [A-Za-z0-9_-]+:$/gm)).toEqual(isStub ? ['  refuse:'] : ['  bind:', '  migrate:']);
  });

  it('refuses any preview database action on the default-branch registration stub', () => {
    if (!isStub) return;
    expect(code).not.toMatch(/secrets\.|\bvars\./);
    expect(code).not.toMatch(/^\s+environment:/m);
    expect(code).not.toMatch(/actions\/checkout|db:push|drizzle-kit|pnpm|npm |node /);
    expect(code.match(/^      - name:/gm)).toHaveLength(1);
    const body = code.split('run: |')[1];
    expect(body).toBeTruthy();
    const script = body.split('\n').filter(line => line.startsWith('          ')).map(line => line.slice(10)).join('\n');
    for (const mode of ['inspect', 'migrate', '']) {
      const result = spawnSync('bash', ['-c', script], {
        env: { PATH: process.env.PATH, INPUT_MODE: mode }, encoding: 'utf8',
      });
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stdout).toContain('::error::');
      expect(result.stdout).toContain('integration/pr7-pr25-runtime-qualification-20260925');
    }
  });

  it('requires exact commit binding, isolated environments, privilege checks and TLS when promoted', () => {
    if (isStub) return;
    expect(code).toMatch(/^  bind:$/m);
    expect(code).toMatch(/^  migrate:\n    needs: bind$/m);
    expect(code).toMatch(/^      approved_commit:$/m);
    expect(code).toContain('APPROVED_COMMIT:');
    expect(code).toContain('DISPATCHED_COMMIT:');
    expect(code).toContain('sakthiai-preview-db-inspect');
    expect(code).toContain('sakthiai-preview-db-migrate');
    expect(code).toContain('DATABASE_EXPECTED_NAME: sakthiai_preview');
    expect(code).toContain('SAKTHIAI_PREVIEW_DB_URL');
    expect(code).toContain('SAKTHIAI_PREVIEW_DB_CA_B64');
    expect(code).toContain('SAKTHIAI_PREVIEW_DB_ROLE');
    expect(code).toContain('rejectUnauthorized: true');
    expect(code).toContain('scripts/preview-migration-guard.mjs grants');
    expect(code).toContain('scripts/preview-migration-guard.mjs pre');
    expect(code).toContain("if: inputs.mode == 'migrate'");
    expect(code).toContain('pnpm db:push');
    expect(code.indexOf('Require approved_commit to equal the dispatched commit')).toBeLessThan(
      code.indexOf('SAKTHIAI_PREVIEW_DB_URL'),
    );
  });

  it('keeps preview database isolation and CA certificate checks in both states', () => {
    // .github/workflows/preview-deploy-preflight.yml checks these strings.
    expect(workflow).toContain('sakthiai_preview');
    expect(workflow).toContain('DATABASE_CA_CERT_B64');
    expect(workflow).not.toMatch(/defaultdb|ramaverse_preview|kirthiverse_preview/);
  });
});
