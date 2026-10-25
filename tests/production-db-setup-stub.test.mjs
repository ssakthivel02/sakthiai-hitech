import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/**
 * The default branch carries only a fail-closed registration stub for the production database workflow.
 *
 * GitHub only dispatches a workflow whose file exists on the default branch; the guarded inspect/migrate workflow
 * lives on the integration branch (PR #29) and is dispatched with an explicit ref. On main this file keeps the
 * workflow identity (path + name + inputs) but reads no secret and writes nothing.
 */
const workflow = readFileSync(new URL('../.github/workflows/production-db-setup.yml', import.meta.url), 'utf8');
const code = workflow.split('\n').filter(line => !line.trim().startsWith('#')).join('\n');

describe('production-db-setup on the default branch is a fail-closed stub', () => {
  it('keeps the workflow identity: same name, manual dispatch only, the four guarded inputs', () => {
    expect(code).toMatch(/^name: SakthiAI Production DB Setup$/m);
    expect(code).toMatch(/^on:\n  workflow_dispatch:\n    inputs:/m);
    expect(code).not.toMatch(/^\s+(push|pull_request|pull_request_target|schedule|workflow_run|repository_dispatch):/m);
    for (const input of ['mode', 'recovery_point', 'approved_commit', 'confirm_database']) {
      expect(code).toMatch(new RegExp(`^      ${input}:$`, 'm'));
    }
  });

  it('reads no secret or variable, uses no environment, checks out nothing and cannot migrate', () => {
    expect(code).not.toMatch(/secrets\./);
    expect(code).not.toMatch(/\bvars\./);
    expect(code).not.toMatch(/^\s+environment:/m);
    expect(code).not.toMatch(/actions\/checkout/);
    expect(code).not.toMatch(/db:push|drizzle-kit|pnpm|npm |node /);
    expect(code).not.toMatch(/DATABASE_URL/);
  });

  it('grants the token nothing beyond read access and serialises with the guarded workflow', () => {
    expect(code).toMatch(/^permissions:\n  contents: read$/m);
    expect(code).toMatch(/^concurrency:\n  group: sakthiai-production-db\n  cancel-in-progress: false$/m);
  });

  it('has exactly one job whose only step refuses with a non-zero exit', () => {
    const jobsBlock = code.split(/^jobs:$/m)[1];
    expect(jobsBlock.match(/^  [A-Za-z0-9_-]+:$/gm)).toEqual(['  refuse:']);
    expect(code.match(/^      - name:/gm)).toHaveLength(1);
    const script = code.split('run: |')[1].split('\n').filter(l => l.startsWith('          ')).map(l => l.slice(10)).join('\n');
    const result = spawnSync('bash', ['-c', script], { env: { PATH: process.env.PATH }, encoding: 'utf8' });
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stdout).toContain('::error::');
    expect(result.stdout).toContain('integration/pr7-pr25-runtime-qualification-20260925');
  });
});
