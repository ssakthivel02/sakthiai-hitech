import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isLowInformationQuery } from '../server/retrieval';

const spec = readFileSync(new URL('../e2e/live-preview/auth-isolation-artifacts.spec.ts', import.meta.url), 'utf8');
const env = readFileSync(new URL('../e2e/live-preview/support/env.ts', import.meta.url), 'utf8');
const workflow = readFileSync(new URL('../.github/workflows/preview-live-browser-check.yml', import.meta.url), 'utf8');

describe('real live-browser smoke is provider-free and does not fabricate grounded artifacts', () => {
  it('uses the server low-information guard to prevent embedding/model retrieval', () => {
    expect(isLowInformationQuery('the')).toBe(true);
    expect(spec).toContain('const NO_PROVIDER_QUERY = "the"');
    const searches = spec.match(/trpcQuery\([^;\n]*"search\.workspace"[^;\n]*\)/g) ?? [];
    expect(searches).toHaveLength(2);
    for (const s of searches) expect(s).toContain('query: NO_PROVIDER_QUERY');
  });

  it('does not create retained chat, upload files, or call content-generating routes', () => {
    expect(spec).not.toMatch(/trpcMutate\([^;\n]*"(?:chat\.(?:send|sendAsync)|artifacts\.saveFromMessage|documents\.upload|projects\.create)"/);
    expect(spec).not.toMatch(/trpcMutate\([^;\n]*"workspace\.ensure"/);
    expect(spec).toMatch(/trpcMutate\([^;\n]*"auth\.logout"/);
    expect(env).not.toContain('requiredAcknowledgement(');
  });

  it('checks a real pre-existing artifact, refusing to pass without an approved fixture', () => {
    expect(spec).toContain('artifacts.list');
    expect(spec).toContain('artifacts.get');
    expect(spec).toContain('find(item => Number.isInteger(item.id) && item.id > 0)');
    expect(spec).toContain('Test account A has no grounded artifact.');
    expect(spec).toContain('expect(crossGet.status, JSON.stringify(crossGet)).toBe(403)');
    expect(spec).toContain('expect(crossSearch.code, JSON.stringify(crossSearch)).toBe("FORBIDDEN")');
  });

  it('keeps commit binding, credential isolation and non-consent default in workflow', () => {
    expect(workflow).toContain('APPROVED_COMMIT:');
    expect(workflow).toContain('DISPATCHED_COMMIT:');
    expect(workflow).toContain('sakthiai-preview-live-test');
    expect(workflow).toContain('sakthiai-hitech-preview.onrender.com');
    expect(workflow).toContain('default: false');
    expect(workflow).toContain('PREVIEW_TEST_ACCOUNT_A_PASSWORD:');
    expect(workflow).toContain('Current smoke creates no chat data');
  });
});
