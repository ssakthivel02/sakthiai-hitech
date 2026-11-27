import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isLowInformationQuery } from '../server/retrieval';
import { assertApprovedPreviewReleaseIdentity } from '../scripts/verify-preview-live-release.mjs';


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
    expect(spec).toContain('const artifacts = (ownList.data as Array<{ id: number }> | undefined) ?? []');
    expect(spec).toContain('for (const item of artifacts.slice(0, 10))');
    expect(spec).toContain('limit: 10');
    expect(spec).toContain('Array.isArray(data.citations) && data.citations.length > 0');
    expect(spec).toContain('Test account A has no grounded artifact among the 10 newest items in 20 private workspaces.');
    expect(spec).toContain('for (const wsA of workspacesA.slice(0, 20))');
    expect(spec).toContain('if (workspacesB.includes(wsA)) continue');
    expect(spec).toContain('Account B must not belong to A');
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

describe('live-browser credentials require exact source and artifact proof', () => {
  const sha = 'a'.repeat(40);
  const valid = () => ({
    service: 'sakthiai',
    repository: 'ssakthivel02/sakthiai-hitech',
    exactCommitKnown: true,
    commit: sha,
    artifact: { state: 'verified', manifestCommit: sha, digest: 'b'.repeat(64) },
  });

  it('accepts only an intact artifact bound to the exact approved source', () => {
    expect(assertApprovedPreviewReleaseIdentity(valid(), sha)).toBe(sha);
  });

  it('refuses wrong service/repository, unknown commit and mismatched source', () => {
    for (const change of [
      { service: 'other' }, { repository: 'other/repository' },
      { exactCommitKnown: false }, { commit: 'c'.repeat(40) }, { commit: undefined },
    ]) expect(() => assertApprovedPreviewReleaseIdentity({ ...valid(), ...change }, sha)).toThrow();
  });

  it('refuses absent, corrupted, unbound and non-digest build artifacts', () => {
    for (const artifact of [
      undefined, { state: 'mismatch', manifestCommit: sha, digest: 'b'.repeat(64) },
      { state: 'absent', manifestCommit: sha, digest: 'b'.repeat(64) },
      { state: 'verified', manifestCommit: 'c'.repeat(40), digest: 'b'.repeat(64) },
      { state: 'verified', manifestCommit: sha, digest: '' },
      { state: 'verified', manifestCommit: sha, digest: 'z'.repeat(64) },
    ]) expect(() => assertApprovedPreviewReleaseIdentity({ ...valid(), artifact }, sha)).toThrow();
  });

  it('refuses malformed release reports and non-exact operator approvals', () => {
    for (const invalid of [null, undefined, '', [], 42]) {
      expect(() => assertApprovedPreviewReleaseIdentity(invalid, sha)).toThrow();
    }
    for (const invalid of [sha.slice(0, 7), sha.toUpperCase(), '', 'main']) {
      expect(() => assertApprovedPreviewReleaseIdentity(valid(), invalid)).toThrow();
    }
  });

  it('requires artifact validation before the only credential-bearing browser step', () => {
    const gate = workflow.indexOf('node scripts/verify-preview-live-release.mjs /tmp/release.json');
    const credentialStep = workflow.indexOf('      - name: Real-authentication live-preview browser check');
    expect(gate).toBeGreaterThan(0);
    expect(credentialStep).toBeGreaterThan(gate);
    expect(workflow.slice(gate, credentialStep)).not.toContain('secrets.PREVIEW_TEST_ACCOUNT');
  });
});
