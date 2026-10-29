import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { evaluateRollbackTarget } from '../scripts/check-rollback-target.mjs';

const contract = JSON.parse(readFileSync(new URL('../release/rollback-contract.json', import.meta.url), 'utf8'));
const j = (n, extra = {}) => Array.from({ length: n }, (_, i) => ({ tag: `00${String(i).padStart(2, '0')}_m`, hash: `h${i}`, statements: ['CREATE TABLE `t' + i + '` (`id` int)'], ...extra[i] }));
const BASE = { contract, target: '403c8f8a2db6fa532a80ae659668fbd18bf779b2', containsBaseline: true };

describe('rollback target qualification', () => {
  it('the currently deployed vulnerable build is never a target, even if everything else matches', () => {
    const r = evaluateRollbackTarget({ ...BASE, target: '469c668e71ceaae800e8605c5814e7017035fdbc', containsBaseline: false, targetJournal: j(11), candidateJournal: j(14), liveHashes: j(14).map(e => e.hash) });
    expect(r.decision).toBe('contain');
    expect(r.containment).toEqual(['suspend-service', 'maintenance-mode']);
    expect(r.problems.join()).toMatch(/forbidden/);
  });

  it('a baseline build that expects a prefix of the live, additive schema qualifies (CI-verified only unless it served before)', () => {
    const r = evaluateRollbackTarget({ ...BASE, targetJournal: j(13), candidateJournal: j(14), liveHashes: j(14).map(e => e.hash) });
    expect(r).toMatchObject({ ok: true, decision: 'rollback-to-target', evidenceClass: expect.stringMatching(/ci-verified-only/) });
    expect(evaluateRollbackTarget({ ...BASE, targetJournal: j(13), candidateJournal: j(14), liveHashes: j(14).map(e => e.hash), targetVerifiedLive: true }).evidenceClass).toBe('previously-live-verified');
  });

  it('refuses a target missing the security baseline', () => {
    expect(evaluateRollbackTarget({ ...BASE, containsBaseline: false, targetJournal: j(13), candidateJournal: j(14), liveHashes: j(14).map(e => e.hash) }).decision).toBe('contain');
  });

  it('refuses a target that needs a migration the live database lacks', () => {
    const r = evaluateRollbackTarget({ ...BASE, targetJournal: j(14), candidateJournal: j(14), liveHashes: j(13).map(e => e.hash) });
    expect(r.problems.join()).toMatch(/live database does not have/);
  });

  it('refuses a target whose migrations differ from the candidate (hash drift)', () => {
    const drift = j(13); drift[5] = { ...drift[5], hash: 'other' };
    expect(evaluateRollbackTarget({ ...BASE, targetJournal: drift, candidateJournal: j(14), liveHashes: j(14).map(e => e.hash) }).problems.join()).toMatch(/not identical/);
  });

  it('refuses to roll back past an applied non-additive migration (needs a restore plan)', () => {
    const cand = j(14, { 13: { statements: ['ALTER TABLE `t1` MODIFY `id` bigint'] } });
    expect(evaluateRollbackTarget({ ...BASE, targetJournal: j(13), candidateJournal: cand, liveHashes: cand.map(e => e.hash) }).problems.join()).toMatch(/not purely additive/);
  });
});
