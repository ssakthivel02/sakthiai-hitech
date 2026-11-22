import {describe,it,expect} from 'vitest';
import {GatewayPolicy} from './gateway_policy';
import {MockModelTransport} from './model_transport';
import {investigateAsync} from './orchestrator';
import {caseFromRecord} from '../caseDoc';
import {FakeTools,newRow} from '../testkit';
import {DEFAULT_TAXONOMY} from '../taxonomy';
import type {PolicyView} from './types';
import type {ModelResponse} from './model_transport';
const view:PolicyView={case:caseFromRecord(newRow() as never),history:[],calls_left:4,steps_left:8,virtual_ms_left:10000,force_final:false,taxonomy:{...DEFAULT_TAXONOMY}};
const final=JSON.stringify({type:'FINAL',outcome:'ABSTAIN',label:'INCONCLUSIVE',summary:'Evidence insufficient',cited:[],confidence:0,remediation_proposal:'No change proposed',hypotheses:[]});
function delayed(){let release!:(r:ModelResponse)=>void,entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});const transport=new MockModelTransport((_r,n)=>n===0?new Promise<ModelResponse>(resolve=>{release=resolve;entered();}):final);return {transport,started,release:()=>release({text:'invalid JSON',tokens_in:5,tokens_out:3})};}
describe('no model continuation after abort or policy deadline',()=>{
 it('sends no request when the decision signal is already aborted',async()=>{
  const ac=new AbortController();ac.abort();const t=new MockModelTransport(()=>final);const p=new GatewayPolicy(t,{maxModelCalls:4,formatRetries:1});
  await expect(p.next(view,ac.signal)).rejects.toMatchObject({name:'AbortError'});expect(t.calls).toHaveLength(0);expect(p.modelCalls).toBe(0);
 });
 it('does not retry an invalid late reply from a transport ignoring cancellation',async()=>{
  const ac=new AbortController(),t=delayed();const p=new GatewayPolicy(t.transport,{maxModelCalls:4,formatRetries:1});const decision=p.next(view,ac.signal);ac.abort();t.release();
  await expect(decision).rejects.toMatchObject({name:'AbortError'});expect(t.transport.calls).toHaveLength(1);expect(p.modelCalls).toBe(1);expect(p.tokensIn).toBe(5);expect(p.tokensOut).toBe(3);
 });
 it.each(['timeout','external-cancel'] as const)('keeps terminal %s classification and prevents a late format retry',async mode=>{
  const t=delayed(),p=new GatewayPolicy(t.transport,{maxModelCalls:4,formatRetries:1}),tools=new FakeTools(),external=new AbortController();let decision:Promise<unknown>|undefined;
  const running=investigateAsync(view.case,{policy:{id:p.id,kind:'llm',next:(v,s)=>{decision=p.next(v,s);return decision as ReturnType<typeof p.next>;}},transport:tools,taxonomy:{...DEFAULT_TAXONOMY},verify:{requireSignatureSupport:false,signatureKb:'off'},policyTimeoutMs:mode==='timeout'?10:1000,signal:external.signal});
  await t.started;if(mode==='external-cancel')external.abort();const result=await running;
  expect(result.stop_reason).toBe(mode==='timeout'?'POLICY_ERROR':'CANCELLED');if(mode==='timeout')expect(result.trace.some(e=>e.type==='policy_error'&&e.payload.message==='POLICY_TIMEOUT')).toBe(true);
  const aborted=t.transport.calls[0]!.signal?.aborted;t.release();await expect(decision).rejects.toMatchObject({name:'AbortError'});expect(aborted).toBe(true);
  expect(t.transport.calls).toHaveLength(1);expect(tools.calls).toHaveLength(0);expect(result.trace_ok).toBe(true);
 });
});
