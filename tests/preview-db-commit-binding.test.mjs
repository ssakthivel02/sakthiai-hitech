import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const wf = readFileSync(new URL('../.github/workflows/preview-db-setup.yml', import.meta.url), 'utf8');
const code = wf.split('\n').filter(l => !l.trim().startsWith('#')).join('\n');
const jobsText = code.split(/^jobs:\n/m)[1];
const [bindJob, migrateJob] = [jobsText.match(/^  bind:\n([\s\S]*?)(?=^  migrate:)/m)?.[1] ?? '', jobsText.match(/^  migrate:\n([\s\S]*)/m)?.[1] ?? ''];
const temps = [];
afterAll(() => temps.forEach(d => rmSync(d, { recursive: true, force: true })));

describe('preview-db-setup.yml: commit binding happens before any credential-bearing job', () => {
  it('requires approved_commit as a dispatch input', () => {
    expect(code).toMatch(/approved_commit:\n\s+description:[^\n]+\n\s+required: true\n\s+type: string/);
  });

  it('runs the binding in a separate job with no environment, secrets or vars', () => {
    expect(bindJob).not.toBe('');
    expect(bindJob).not.toMatch(/environment:|secrets\.|vars\.|actions\/checkout/);
    expect(bindJob).toMatch(/APPROVED_COMMIT: \$\{\{ inputs\.approved_commit \}\}/);
    expect(bindJob).toMatch(/DISPATCHED_COMMIT: \$\{\{ github\.sha \}\}/);
    // inputs reach the script only through env, never interpolated into the shell text
    expect(bindJob.split('run: |')[1]).not.toMatch(/\$\{\{/);
  });

  it('makes the database job depend on the binding and check out exactly the dispatched commit', () => {
    expect(migrateJob).toMatch(/^    needs: bind$/m);
    expect(migrateJob.indexOf('needs: bind')).toBeLessThan(migrateJob.indexOf('environment:'));
    expect(migrateJob).toMatch(/uses: actions\/checkout@v4\n\s+with:\n\s+ref: \$\{\{ github\.sha \}\}/);
  });

  it('is the only job that can run before the database environment (no other job binds secrets)', () => {
    const jobs = [...jobsText.matchAll(/^  ([a-z-]+):\n/gm)].map(m => m[1]);
    expect(jobs).toEqual(['bind', 'migrate']);
    expect((bindJob.match(/secrets\./g) ?? []).length).toBe(0);
  });
});

describe('preview-db-setup.yml: binding step, executed', () => {
  const block = bindJob.split(/\n      - name: /)[1];
  const script = block.split('run: |\n')[1].split('\n').filter(l => l.startsWith('          ')).map(l => l.slice(10)).join('\n');
  const repo = mkdtempSync(path.join(os.tmpdir(), 'preview-bind-'));
  temps.push(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'x'], { cwd: repo });
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  const run = env => spawnSync('bash', ['-c', script], { cwd: repo, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });

  it('passes only for the exact full lowercase SHA', () => {
    expect(script).toMatch(/^set -euo pipefail/);
    expect(run({ APPROVED_COMMIT: head, DISPATCHED_COMMIT: head }).status).toBe(0);
    const refused = {
      'different commit': { APPROVED_COMMIT: '0'.repeat(40), DISPATCHED_COMMIT: head },
      'short commit': { APPROVED_COMMIT: head.slice(0, 7), DISPATCHED_COMMIT: head },
      'uppercase commit': { APPROVED_COMMIT: head.toUpperCase(), DISPATCHED_COMMIT: head },
      'empty approval': { APPROVED_COMMIT: '', DISPATCHED_COMMIT: head },
      'approval unset': { DISPATCHED_COMMIT: head },
      'dispatched commit unset': { APPROVED_COMMIT: head },
      'shell metacharacters': { APPROVED_COMMIT: `${head}; echo pwned`, DISPATCHED_COMMIT: head },
      'both empty (equal but meaningless)': { APPROVED_COMMIT: '', DISPATCHED_COMMIT: '' },
      'both the same non-SHA': { APPROVED_COMMIT: 'main', DISPATCHED_COMMIT: 'main' },
      'branch name instead of SHA': { APPROVED_COMMIT: 'integration/pr7-pr25-runtime-qualification-20260925', DISPATCHED_COMMIT: head },
    };
    for (const [label, env] of Object.entries(refused)) {
      const r = run(env);
      expect(r.status, label).not.toBe(0);
      expect(r.stdout + r.stderr, label).not.toMatch(/pwned\n/);
    }
  });
});
