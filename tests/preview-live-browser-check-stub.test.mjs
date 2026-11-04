import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(new URL('../.github/workflows/preview-live-browser-check.yml', import.meta.url), 'utf8');
const code = workflow.split('\n').filter(line => !line.trim().startsWith('#')).join('\n');

describe('default-branch browser-check registration fails closed', () => {
  it('preserves only the manual dispatch identity and exact guarded inputs', () => {
    expect(code).toMatch(/^name: SakthiAI Preview Live Browser Check$/m);
    expect(code).toMatch(/^on:\n  workflow_dispatch:\n    inputs:/m);
    expect(code).not.toMatch(/^\s+(push|pull_request|pull_request_target|schedule|workflow_run|repository_dispatch):/m);
    for (const key of ['preview_url', 'approved_commit', 'acknowledge_chat_data_retention']) {
      expect(code).toMatch(new RegExp('^      ' + key + ':$', 'm'));
    }
    expect(code).toMatch(/^        default: false$/m);
  });

  it('cannot bind secrets, run a browser, check out code or contact a preview', () => {
    expect(code).not.toMatch(/\$\{\{/);
    expect(code).not.toMatch(/^\s+(?:environment|env|container|services|uses):/m);
    expect(code).not.toMatch(/actions\/checkout|playwright|pnpm|npm |node |curl |wget |fetch\(|api\/|chat\.send|onrender\.com/);
    expect(code).not.toMatch(/secrets\.|\bvars\.|PREVIEW_TEST_ACCOUNT_|DATABASE_URL/);
  });

  it('uses a read-only token and the same concurrency group as the guarded workflow', () => {
    expect(code).toMatch(/^permissions:\n  contents: read$/m);
    expect(code).toMatch(/^concurrency:\n  group: sakthiai-preview-live-browser-check\n  cancel-in-progress: false$/m);
  });

  it('has exactly one job and a single refusal step that exits nonzero', () => {
    expect(code.split(/^jobs:$/m)[1].match(/^  [A-Za-z0-9_-]+:$/gm)).toEqual(['  refuse:']);
    expect(code.match(/^      - name:/gm)).toHaveLength(1);
    const body = code.split('run: |')[1];
    expect(body).toBeTruthy();
    const script = body.split('\n').filter(line => line.startsWith('          ')).map(line => line.slice(10)).join('\n');
    for (const acknowledged of ['false', 'true']) {
      const run = spawnSync('bash', ['-c', script], {
        env: { PATH: process.env.PATH, INPUT_ACKNOWLEDGE_CHAT_DATA_RETENTION: acknowledged },
        encoding: 'utf8',
      });
      expect(run.status, run.stdout + run.stderr).toBe(1);
      expect(run.stdout).toContain('::error::');
      expect(run.stdout).toContain('integration branch');
    }
  });
});
