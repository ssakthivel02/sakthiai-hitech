import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/**
 * This file may first register an always-refusing default-branch stub, then later
 * be replaced by the guarded implementation when PR #36/PR #29 is integrated.
 * Validate BOTH recognized states. Never leave a permanent stub-only test that
 * rejects the correctly guarded production workflow at release time.
 */
const workflow = readFileSync(new URL('../.github/workflows/preview-live-browser-check.yml', import.meta.url), 'utf8');
const code = workflow.split('\n').filter(line => !line.trim().startsWith('#')).join('\n');
const isStub = /^  refuse:$/m.test(code);

describe('preview-live-browser-check registration and guarded replacement', () => {
  it('preserves manual dispatch, matching inputs and safe default consent in either state', () => {
    expect(code).toMatch(/^name: SakthiAI Preview Live Browser Check$/m);
    expect(code).toMatch(/^on:\n  workflow_dispatch:\n    inputs:/m);
    expect(code).not.toMatch(/^\s+(push|pull_request|pull_request_target|schedule|workflow_run|repository_dispatch):/m);
    for (const key of ['preview_url', 'approved_commit', 'acknowledge_chat_data_retention']) {
      expect(code).toMatch(new RegExp('^      ' + key + ':$', 'm'));
    }
    expect(code).toMatch(/^        default: false$/m);
    expect(code).toMatch(/^permissions:\n  contents: read$/m);
    expect(code).toMatch(/^concurrency:\n  group: sakthiai-preview-live-browser-check\n  cancel-in-progress: false$/m);
  });

  it('refuses safely in the default-branch registration state', () => {
    if (!isStub) return;
    expect(code).not.toMatch(/\$\{\{/);
    expect(code).not.toMatch(/^\s+(?:environment|env|container|services|uses):/m);
    expect(code).not.toMatch(/actions\/checkout|playwright|pnpm|npm |node |curl |wget |fetch\(|api\/|chat\.send|onrender\.com/);
    expect(code).not.toMatch(/secrets\.|\bvars\.|PREVIEW_TEST_ACCOUNT_|DATABASE_URL/);
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

  it('enforces binding, host pinning, environment isolation and secret order after guarded replacement', () => {
    if (isStub) return;
    expect(code).toMatch(/^  bind:$/m);
    expect(code).toMatch(/^  live-browser-check:$/m);
    expect(code).toMatch(/^    needs: bind$/m);
    expect(code).toMatch(/^    environment: sakthiai-preview-live-test$/m);
    expect(code).toContain('APPROVED_COMMIT:');
    expect(code).toContain('DISPATCHED_COMMIT:');
    expect(code).toContain('EXPECTED_COMMIT:');
    expect(code).toContain('https:');
    expect(code).toContain('sakthiai-hitech-preview.onrender.com');
    expect(code).toContain('/releasez');
    const releaseCheck = code.indexOf('Verify the preview is already serving the approved commit before touching any credential');
    const testStep = code.indexOf('Real-authentication live-preview browser check (no stub login, no bypass)');
    const firstSecret = code.indexOf('secrets.PREVIEW_TEST_ACCOUNT_A_EMAIL');
    expect(releaseCheck).toBeGreaterThan(0);
    expect(testStep).toBeGreaterThan(releaseCheck);
    expect(firstSecret).toBeGreaterThan(testStep);
    expect(code.match(/secrets\.PREVIEW_TEST_ACCOUNT_[AB]_(EMAIL|PASSWORD)/g)).toHaveLength(4);
    expect(code.slice(0, testStep)).not.toContain('secrets.PREVIEW_TEST_ACCOUNT_');
    expect(code).toContain('PREVIEW_TEST_ACKNOWLEDGE_CHAT_RETENTION:');
  });
});
