import {describe,it,expect} from 'vitest';
import {buildPrompt,parseDecision} from './llm_contract';
import {GatewayPolicy} from './gateway_policy';
import {MockModelTransport} from './model_transport';
import type {PolicyView} from './types';
const view:PolicyView={case:{case_id:'feedback-control',tenant:'ws-7',objective:'Investigate',alert:{title:'Failure',severity:'high',service:'demo',fired_at:'2026-11-20T00:00:00Z',description:'Failure'},operator_notes:[],inventory:{services:['demo'],hosts:[]},allowed_tools:['logs.search'],limits:{max_tool_calls:2,max_steps:4,max_retries_per_call:0,max_virtual_ms:10000}},history:[],taxonomy:{INCONCLUSIVE:'Insufficient evidence'},calls_left:2,steps_left:4,virtual_ms_left:10000,force_final:false};
const call={type:'CALL',tool:'logs.search',target:'demo',rationale:'Read logs',hypotheses:[]};
const abstain={type:'FINAL',outcome:'ABSTAIN',label:'INCONCLUSIVE',summary:'Evidence is insufficient',cited:[],contradictions:[],confidence:0,remediation_proposal:'No change proposed',next_safe_steps:[],hypotheses:[]};
describe('trusted CALL constraint feedback',()=>{
 it('tells the model the existing rationale limit before its first decision',()=>{expect(buildPrompt(view).system).toContain('CALL rationale must be a string of at most 300 characters');});
 it('retains the exact 300-character boundary without silent truncation',()=>{const rationale='x'.repeat(300);const d=parseDecision(JSON.stringify({...call,rationale}),view);expect(d.type).toBe('CALL');if(d.type==='CALL')expect(d.rationale).toBe(rationale);});
 it.each([['tool',61,60],['target',121,120],['rationale',301,300]] as const)('names only the trusted %s constraint on oversized input',(field,size,max)=>{expect(()=>parseDecision(JSON.stringify({...call,[field]:'x'.repeat(size)}),view)).toThrow(`CALL ${field} must be a string of at most ${max} characters`);});
 it.each(['tool','target','rationale'] as const)('gives the same trusted %s constraint on a non-string',(field)=>{const max={tool:60,target:120,rationale:300}[field];expect(()=>parseDecision(JSON.stringify({...call,[field]:{injected:'untrusted marker'}}),view)).toThrow(`CALL ${field} must be a string of at most ${max} characters`);});
 it('feeds the specific limit back without echoing the rejected reply',async()=>{const secret='rejected-private-marker';const t=new MockModelTransport((_r,n)=>JSON.stringify(n===0?{...call,rationale:secret+'x'.repeat(301)}:abstain));const p=new GatewayPolicy(t,{maxModelCalls:2,formatRetries:1});const d=await p.next(view);expect(d.type).toBe('FINAL');expect(t.calls).toHaveLength(2);expect(t.calls[1]!.user).toContain('CALL rationale must be a string of at most 300 characters');expect(t.calls[1]!.user).not.toContain(secret);});
 it('keeps the same logical call ceiling despite more precise feedback',async()=>{const t=new MockModelTransport(()=>JSON.stringify({...call,rationale:'x'.repeat(301)}));const p=new GatewayPolicy(t,{maxModelCalls:1,formatRetries:1});await expect(p.next(view)).rejects.toThrow('MODEL_CALL_BUDGET_EXHAUSTED');expect(t.calls).toHaveLength(1);});
});
