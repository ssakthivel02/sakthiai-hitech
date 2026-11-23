import {describe,it,expect} from 'vitest';
import {GatewayPolicy} from './gateway_policy';
import {buildPrompt} from './llm_contract';
import {MockModelTransport} from './model_transport';
import type {PolicyView} from './types';

const view:PolicyView={case:{case_id:'prompt-budget',tenant:'ws-7',objective:'Investigate',alert:{title:'Failure',severity:'high',service:'demo',fired_at:'2026-11-20T00:00:00Z',description:'Failure'},operator_notes:[],inventory:{services:['demo'],hosts:[]},allowed_tools:['logs.search'],limits:{max_tool_calls:2,max_steps:4,max_retries_per_call:0,max_virtual_ms:10000}},history:[],taxonomy:{INCONCLUSIVE:'Insufficient evidence'},calls_left:2,steps_left:4,virtual_ms_left:10000,force_final:false};
const final=JSON.stringify({type:'FINAL',outcome:'ABSTAIN',label:'INCONCLUSIVE',summary:'Evidence is insufficient',cited:[],confidence:0,remediation_proposal:'No change proposed',next_safe_steps:[]});
const base=buildPrompt(view),size=base.system.length+base.user.length;
const retryFeedback='\n\nYour previous reply was rejected by the decision validator (not a single JSON object). Reply with exactly one valid JSON object and nothing else.';

describe('per-attempt prompt character budget',()=>{
 it('does not issue an oversized initial prompt',async()=>{
  const t=new MockModelTransport(()=>final),p=new GatewayPolicy(t,{maxPromptChars:size-1});
  await expect(p.next(view)).rejects.toThrow('PROMPT_TOO_LARGE');expect(t.calls).toHaveLength(0);expect(p.modelCalls).toBe(0);
 });
 it('allows the exact initial boundary without truncating evidence',async()=>{
  const t=new MockModelTransport(()=>final),p=new GatewayPolicy(t,{maxPromptChars:size});
  expect((await p.next(view)).type).toBe('FINAL');expect(t.calls[0]!.user).toBe(base.user);expect(t.calls[0]!.system).toBe(base.system);
 });
 it('blocks retry feedback that would exceed the cap before spending another call',async()=>{
  const t=new MockModelTransport((_r,n)=>n===0?{text:'invalid JSON',tokens_in:17,tokens_out:3}:final);
  const p=new GatewayPolicy(t,{maxPromptChars:size,maxModelCalls:2,formatRetries:1});
  await expect(p.next(view)).rejects.toThrow('PROMPT_TOO_LARGE');
  expect(t.calls).toHaveLength(1);expect(p.modelCalls).toBe(1);expect(p.tokensIn).toBe(17);expect(p.tokensOut).toBe(3);
 });
 it('allows a retry exactly at the cap and preserves the full original prompt',async()=>{
  const t=new MockModelTransport((_r,n)=>n===0?'invalid JSON':final);
  const p=new GatewayPolicy(t,{maxPromptChars:size+retryFeedback.length,maxModelCalls:2,formatRetries:1});
  expect((await p.next(view)).type).toBe('FINAL');expect(t.calls).toHaveLength(2);
  expect(t.calls[1]!.user).toBe(base.user+retryFeedback);
  expect(t.calls[1]!.system.length+t.calls[1]!.user.length).toBe(size+retryFeedback.length);
 });
});
