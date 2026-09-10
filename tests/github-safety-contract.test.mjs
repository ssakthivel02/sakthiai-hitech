import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const control = JSON.parse(readFileSync(new URL('../ACTIVE_MASTER_CONTROL.json', import.meta.url), 'utf8'));
const protectedGate = readFileSync(new URL('../.github/workflows/protected-main-gate.yml', import.meta.url), 'utf8');
const parallelGuard = readFileSync(new URL('../.github/workflows/parallel-work-guard.yml', import.meta.url), 'utf8');
const policy = readFileSync(new URL('../.github/PARALLEL_WORK_POLICY.md', import.meta.url), 'utf8');

describe('GOV-SAFE-001 GitHub safety contract', () => {
  it('pins canonical repository and integration branch', () => {
    expect(control.schemaVersion).toBe('1.1.0');
    expect(control.canonicalRepository).toBe('ssakthivel02/sakthiai-hitech');
    expect(control.activeBranch).toBe('main');
  });

  it('requires every strict safety marker', () => {
    const values = Object.values(control.githubSafetyPolicy ?? {});
    expect(values.length).toBeGreaterThanOrEqual(15);
    expect(values.every(value => value === true)).toBe(true);
  });

  it('keeps exact-head and destructive-operation controls explicit', () => {
    expect(control.githubSafetyPolicy.mergeOnlyAfterExactHeadRequiredChecksPass).toBe(true);
    expect(control.githubSafetyPolicy.apiMergeRequiresExpectedHeadShaGuard).toBe(true);
    expect(control.githubSafetyPolicy.forcePushProhibited).toBe(true);
    expect(control.githubSafetyPolicy.destructiveRefMovementProhibited).toBe(true);
    expect(control.githubSafetyPolicy.requiredCiWeakeningProhibited).toBe(true);
  });

  it('enforces current-main ancestry in the parallel guard', () => {
    expect(parallelGuard).toContain('git merge-base --is-ancestor origin/main HEAD');
    expect(parallelGuard).toContain('CURRENT_MAIN_ANCESTRY_PASS');
  });

  it('enforces the machine-readable safety markers in protected main gate', () => {
    expect(protectedGate).toContain('requiredSafetyTrue');
    expect(protectedGate).toContain('GITHUB_SAFETY_CONTRACT_PASS');
  });

  it('states that server-side protection remains separately required', () => {
    expect(policy).toContain('server-side rulesets/branch protection');
    expect(policy).toContain('block force pushes and deletions');
  });
});
