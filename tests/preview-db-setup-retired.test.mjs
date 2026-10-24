import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/**
 * The default branch must never carry a dispatchable database writer.
 *
 * GitHub only dispatches a workflow whose file exists on the default branch, and the Actions UI pre-selects the
 * default branch. The guarded inspect/migrate workflow lives on the integration branch (PR #29) and is dispatched
 * with an explicit ref; on main this file is a fail-closed refusal that keeps the workflow identity (path + name +
 * inputs) so that guarded dispatch keeps working, but itself reads no secret and writes nothing.
 */
const workflow = readFileSync(new URL('../.github/workflows/preview-db-setup.yml', import.meta.url), 'utf8');
const lines = workflow.split('\n');
const code = lines.filter(line => !line.trim().startsWith('#')).join('\n');

describe('preview-db-setup on the default branch is retired and fails closed', () => {
  it('keeps the workflow identity: same name, manual dispatch only, same inputs as the guarded workflow', () => {
    expect(code).toMatch(/^name: SakthiAI Preview DB Setup$/m);
    expect(code).toMatch(/^on:\n  workflow_dispatch:\n    inputs:/m);
    expect(code).not.toMatch(/^\s+(push|pull_request|pull_request_target|schedule|workflow_run|repository_dispatch):/m);
    expect(code).toMatch(/^      recovery_point:$/m);
    expect(code).toMatch(/^      mode:$/m);
  });

  it('reads no secret, uses no environment, checks out nothing and cannot migrate', () => {
    expect(code).not.toMatch(/secrets\./);
    expect(code).not.toMatch(/\bvars\./);
    expect(code).not.toMatch(/^\s+environment:/m);
    expect(code).not.toMatch(/actions\/checkout/);
    expect(code).not.toMatch(/db:push|drizzle-kit|pnpm|npm |node /);
    expect(code).not.toMatch(/DATABASE_URL/);
  });

  it('grants the token nothing beyond read access and serialises with the guarded workflow', () => {
    expect(code).toMatch(/^permissions:\n  contents: read$/m);
    expect(code).toMatch(/^concurrency:\n  group: sakthiai-preview-db\n  cancel-in-progress: false$/m);
  });

  it('has exactly one job whose only step refuses with a non-zero exit, whatever the inputs', () => {
    const jobsBlock = code.split(/^jobs:$/m)[1];
    expect(jobsBlock).toBeTruthy();
    expect(jobsBlock.match(/^  [A-Za-z0-9_-]+:$/gm)).toEqual(['  refuse:']);
    expect(code.match(/^      - name:/gm)).toHaveLength(1);
    const run = code.split('run: |')[1];
    expect(run).toBeTruthy();
    const script = run.split('\n').filter(l => l.startsWith('          ')).map(l => l.slice(10)).join('\n');
    for (const inputs of [{ mode: 'inspect', rp: '2026-10-07T07:58:06Z' }, { mode: 'migrate', rp: '2026-10-07T07:58:06Z' }, { mode: '', rp: '' }]) {
      const result = spawnSync('bash', ['-c', script], { env: { PATH: process.env.PATH, INPUT_MODE: inputs.mode, INPUT_RECOVERY_POINT: inputs.rp }, encoding: 'utf8' });
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stdout).toContain('::error::');
      expect(result.stdout).toContain('integration/pr7-pr25-runtime-qualification-20260925');
    }
  });

  it('still satisfies the existing preview preflight isolation and TLS contract on main', () => {
    // .github/workflows/preview-deploy-preflight.yml greps this file:
    expect(workflow).toContain('sakthiai_preview');
    expect(workflow).toContain('DATABASE_CA_CERT_B64');
    expect(workflow).not.toMatch(/defaultdb|ramaverse_preview|kirthiverse_preview/);
  });
});
