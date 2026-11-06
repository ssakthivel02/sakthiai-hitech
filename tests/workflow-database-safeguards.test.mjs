import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Repository-wide safeguard for GitHub workflows that can touch a database.
 *
 * Successor to the retired-stub tests (preview-db-setup-retired, production-db-setup-stub), which asserted that the
 * default branch carried only fail-closed stubs. Once the guarded workflows are on the default branch, the property that
 * matters is the same one stated generally: no workflow may hold a database credential or run a schema write outside an
 * environment-scoped, manual-dispatch, serialised, mode-gated job.
 */
const dir = new URL('../.github/workflows/', import.meta.url);
const workflows = readdirSync(dir)
  .filter(f => /\.ya?ml$/.test(f))
  .map(f => ({ file: f, text: readFileSync(new URL(f, dir), 'utf8') }));
const code = (text) => text.split('\n').filter(l => !l.trim().startsWith('#')).join('\n');

const writers = workflows.filter(w => /db:push|drizzle-kit|db:backfill/.test(code(w.text)));

describe('workflows that can write to a database', () => {
  it('finds the guarded preview and production workflows (test is not vacuous)', () => {
    expect(writers.map(w => w.file).sort()).toEqual(expect.arrayContaining(['preview-db-setup.yml', 'production-db-setup.yml']));
  });

  it('never reference the legacy repository-level credentials, in code or comments', () => {
    for (const w of workflows) expect(w.text, w.file).not.toMatch(/SAKTHIAI_PREVIEW_DATABASE_URL|AIVEN_MYSQL_CA_CERT_B64/);
  });

  it('read database credentials only through an environment-scoped job', () => {
    for (const w of writers) {
      const c = code(w.text);
      expect(c, w.file).toMatch(/^\s+environment:\s*\$\{\{/m);
      for (const s of c.match(/secrets\.[A-Z0-9_]+/g) ?? []) {
        if (s === 'secrets.GITHUB_TOKEN') continue;
        expect(s, w.file).toMatch(/^secrets\.SAKTHIAI_(PREVIEW|PRODUCTION)_DB_(URL|CA_B64)$/);
      }
    }
  });

  it('are manual-dispatch only', () => {
    for (const w of writers) {
      const c = code(w.text);
      expect(c, w.file).toMatch(/^\s+workflow_dispatch:/m);
      expect(c, w.file).not.toMatch(/^\s+(push|pull_request|pull_request_target|schedule|workflow_run|repository_dispatch):/m);
    }
  });

  it('serialise per target and grant the token read-only repository access', () => {
    for (const w of writers) {
      const c = code(w.text);
      expect(c, w.file).toMatch(/^permissions:\s*\n\s+contents: read\s*$/m);
      expect(c, w.file).toMatch(/group: sakthiai-(preview|production)-db/);
      expect(c, w.file).toMatch(/cancel-in-progress: false/);
    }
  });

  it('write the schema only in steps gated on mode == migrate', () => {
    for (const w of writers) {
      const steps = code(w.text).split(/^\s+- name:/m).slice(1);
      for (const step of steps) {
        if (/db:push|db:backfill/.test(step)) expect(step, w.file).toMatch(/if:.*inputs\.mode == 'migrate'/);
      }
    }
  });
});
