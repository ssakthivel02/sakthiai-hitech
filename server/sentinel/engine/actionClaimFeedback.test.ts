import { describe, expect, it } from 'vitest';
import { GatewayPolicy } from './gateway_policy';
import { MockModelTransport } from './model_transport';
import { ContractError } from './llm_contract';
import { sha256 } from './canon';
import { verifyFinal } from './verifier';
import type { PolicyView } from './types';
const view: PolicyView = { case: { case_id: 'action-feedback', tenant: 'ws-7', objective: 'Investigate', alert: { title: 'Failure', severity: 'high', service: 'demo', fired_at: '2026-11-28T00:00:00Z', description: 'Failure' }, operator_notes: [], inventory: { services: ['demo'], hosts: [] }, allowed_tools: ['logs.search'], limits: { max_tool_calls: 2, max_steps: 4, max_retries_per_call: 0, max_virtual_ms: 10000 } }, history: [], taxonomy: { INCONCLUSIVE: 'Insufficient evidence' }, calls_left: 2, steps_left: 4, virtual_ms_left: 10000, force_final: false };
const safe = { type: 'FINAL', outcome: 'ABSTAIN', label: 'INCONCLUSIVE', summary: 'Evidence is insufficient', cited: [], confidence: 0, remediation_proposal: 'No change proposed', next_safe_steps: [], hypotheses: [] };
const bad = { ...safe, summary: 'I restarted demo. MODEL_ONLY_MARKER' };
const call = { type: 'CALL', tool: 'logs.search', target: 'demo', rationale: 'Read logs', hypotheses: [] };
describe('bounded feedback for final action claims', () => {
  it.each(['summary', 'remediation_proposal', 'next_safe_steps', 'abstain_reason'])('rejects action claims in %s before accepting a correction', async field => {
    const raw = JSON.stringify({ ...safe, [field]: field === 'next_safe_steps' ? ['I restarted demo. MODEL_ONLY_MARKER'] : 'I restarted demo. MODEL_ONLY_MARKER' });
    const t = new MockModelTransport((_req, n) => n === 0 ? raw : JSON.stringify(safe));
    const p = new GatewayPolicy(t, { maxModelCalls: 2, formatRetries: 1 }); const d = await p.next(view);
    expect(t.calls).toHaveLength(2); expect(d.type).toBe('FINAL');
    expect(t.calls[1]!.user).toContain('FINAL action claim'); expect(t.calls[1]!.user).not.toContain('MODEL_ONLY_MARKER');
    expect(d.model_meta).toMatchObject({ attempt: 1, model_calls: 2, contract_rejections: [{ attempt: 0, response_sha256: sha256(raw), prompt_sha256: sha256(t.calls[0]!.system + '\n' + t.calls[0]!.user) }] });
    if (d.type !== 'FINAL') throw Error('expected FINAL'); expect(d.final.summary).toBe(safe.summary);
  });
  it('keeps conservative historical-action detection without a semantic exception', async () => {
    const t = new MockModelTransport((_req, n) => JSON.stringify(n === 0 ? { ...safe, summary: 'The job was disabled during maintenance.' } : { ...safe, summary: 'The configuration reports a disabled job; its cause remains unverified.' }));
    const d = await new GatewayPolicy(t, { maxModelCalls: 2, formatRetries: 1 }).next(view);
    expect(t.calls).toHaveLength(2); expect(d.type).toBe('FINAL');
  });
  it('exhausts its existing correction count on repeated claims', async () => {
    const t = new MockModelTransport(() => JSON.stringify(bad)); const p = new GatewayPolicy(t, { maxModelCalls: 8, formatRetries: 1 });
    await expect(p.next(view)).rejects.toThrow(ContractError); expect(t.calls).toHaveLength(2); expect(p.modelCalls).toBe(2);
  });
  it('does not refund the first rejected call or exceed a one-call budget', async () => {
    const t = new MockModelTransport(() => JSON.stringify(bad)); const p = new GatewayPolicy(t, { maxModelCalls: 1, formatRetries: 3 });
    await expect(p.next(view)).rejects.toThrow('MODEL_CALL_BUDGET_EXHAUSTED'); expect(t.calls).toHaveLength(1); expect(p.modelCalls).toBe(1);
  });
  it('does not allow correction to request another diagnostic tool', async () => {
    const t = new MockModelTransport((_req, n) => JSON.stringify(n === 0 ? bad : call));
    await expect(new GatewayPolicy(t, { maxModelCalls: 2, formatRetries: 1 }).next(view)).rejects.toThrow(ContractError); expect(t.calls).toHaveLength(2);
  });
  it('retains cancellation before a correction', async () => {
    const ac = new AbortController(); const t = new MockModelTransport(() => { ac.abort(); return JSON.stringify(bad); });
    await expect(new GatewayPolicy(t, { maxModelCalls: 2, formatRetries: 1 }).next(view, ac.signal)).rejects.toBeDefined(); expect(t.calls).toHaveLength(1);
  });
  it('leaves a valid initial final at one call and the direct verifier strict', async () => {
    const t = new MockModelTransport(() => JSON.stringify(safe)); const d = await new GatewayPolicy(t).next(view); expect(t.calls).toHaveLength(1);
    if (d.type !== 'FINAL') throw Error('expected FINAL');
    const opts = { requireSignatureSupport: false, signatureKb: 'off' as const };
    expect(verifyFinal(d.final, view.case, new Map(), view.taxonomy, opts).ok).toBe(true);
    expect(verifyFinal({ ...d.final, summary: bad.summary }, view.case, new Map(), view.taxonomy, opts).fatal).toContain('CLAIM:false-remediation-claim in summary');
    expect(d.model_meta).not.toHaveProperty('contract_rejections');
  });
});

describe('durable handler action-claim correction', () => {
  it.each([4, 3])('reserves every model call and preserves the %i-call ceiling', async maxModelCalls => {
    const { createSentinelInvestigateHandler } = await import('../handler');
    const { InMemorySentinelStore } = await import('../testing');
    const { FakeTools, fakeCtx, newRow, hyp, WS, ID } = await import('../testkit');
    const { verifyTrace } = await import('./trace');
    const store = new InMemorySentinelStore(); await store.create(newRow()); const tools = new FakeTools();
    const t = new MockModelTransport((req, n) => {
      const user = JSON.parse(req.user.split('\n\nYour previous reply')[0]!);
      const ids = user.history.flatMap((h: { records: Array<{ rid: string }> }) => h.records.map(r => r.rid));
      if (!ids.length) return JSON.stringify({ ...call, target: 'orders-db', hypotheses: hyp([], 0.4) });
      if (ids.length === 1) return JSON.stringify({ ...call, tool: 'metrics.query', target: 'db-1', hypotheses: hyp(ids, 0.6) });
      return JSON.stringify({ ...safe, outcome: 'DIAGNOSIS', label: 'DISK_FULL', cited: ids, confidence: 0.8, summary: n === 2 ? 'I restarted the service.' : 'Logs and capacity metrics show disk pressure.', remediation_proposal: 'Review storage capacity under change control', hypotheses: hyp(ids, 0.9) });
    });
    const { ctx, state } = fakeCtx();
    const out = await createSentinelInvestigateHandler({ store, enabled: () => true, config: () => ({ maxModelCalls, formatRetries: 1, policyTimeoutMs: 2000, toolAttemptTimeoutMs: 1000, cancelPollMs: 10 }), transportFor: () => tools, modelFor: () => t })(ctx) as { verified: boolean };
    expect(t.calls).toHaveLength(maxModelCalls); expect(tools.calls).toHaveLength(2);
    expect(state.savedCheckpoint).toMatchObject({ modelCalls: maxModelCalls });
    const events = await store.readEvents(WS, ID); expect(verifyTrace(events, ID).ok).toBe(true);
    expect(out.verified).toBe(maxModelCalls === 4); // The stored summary verifies diagnoses only, never abstentions.
    const final = events.find(e => e.type === 'final')!.payload;
    if (maxModelCalls === 4) {
      expect(final).toMatchObject({ outcome: 'DIAGNOSIS', remediation: { executed: false, requires_approval: true } });
      expect(events.find(e => e.type === 'decision' && (e.payload as { type: string }).type === 'FINAL')!.payload).toMatchObject({ model_meta: { model_calls: 4, contract_rejections: [expect.objectContaining({ attempt: 0 })] } });
    } else {
      expect(final).toMatchObject({ outcome: 'ABSTAIN' });
      expect(events.at(-1)!.payload).toMatchObject({ stop_reason: 'POLICY_ERROR' });
    }
  });
});
