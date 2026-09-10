import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const status = JSON.parse(readFileSync(new URL('../release/GOV_SAFE_001_STATUS.json', import.meta.url), 'utf8'));

describe('GOV-SAFE-001 server-side protection hold', () => {
  it('keeps production-impacting release blocked until GitHub protection is verified', () => {
    expect(status.control).toBe('GOV-SAFE-001');
    expect(status.canonicalRepository).toBe('ssakthivel02/sakthiai-hitech');
    expect(status.integrationBranch).toBe('main');
    expect(status.repositoryPolicyImplemented).toBe(true);
    expect(status.serverSideProtectionVerified).toBe(false);
    expect(status.productionImpactingReleaseAllowed).toBe(false);
  });

  it('requires the critical server-side controls', () => {
    expect(status.requiredServerSideControls).toEqual(expect.arrayContaining([
      'pull_request_required',
      'protected-main-gate_required',
      'parallel-work-guard_required',
      'branch_up_to_date_required',
      'force_push_blocked',
      'branch_deletion_blocked'
    ]));
  });
});
