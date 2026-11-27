import {spawnSync} from 'node:child_process';
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


describe('synchronous policy cancellation contains the abandoned promise',()=>{
 it.each(['direct-policy','gateway-policy'] as const)('does not crash a real Node process after %s cancels before guard registration',mode=>{
  const script=`
    import {investigateAsync} from './server/sentinel/engine/orchestrator.ts';
    import {GatewayPolicy} from './server/sentinel/engine/gateway_policy.ts';
    import {MockModelTransport} from './server/sentinel/engine/model_transport.ts';
    import {caseFromRecord} from './server/sentinel/caseDoc.ts';
    import {FakeTools,newRow} from './server/sentinel/testkit.ts';
    import {DEFAULT_TAXONOMY} from './server/sentinel/taxonomy.ts';
    const external=new AbortController(),tools=new FakeTools();let calls=0;
    const transport=new MockModelTransport(()=>{calls++;external.abort();return '{}';});
    const policy=${JSON.stringify(mode)}==='gateway-policy'?new GatewayPolicy(transport,{maxModelCalls:4,formatRetries:1}):{
      id:'synchronous-abort-policy',kind:'llm',next(){calls++;external.abort();return Promise.reject(new Error('SYNTHETIC_CANCELLED_POLICY'));}
    };
    const result=await investigateAsync(caseFromRecord(newRow()),{policy,transport:tools,taxonomy:{...DEFAULT_TAXONOMY},verify:{requireSignatureSupport:false,signatureKb:'off'},signal:external.signal,policyTimeoutMs:1000});
    console.log(JSON.stringify({stop:result.stop_reason,outcome:result.final.outcome,trace:result.trace_ok,calls,tools:tools.calls.length}));
  `;
  const child=spawnSync(process.execPath,['--import','tsx','--input-type=module','--eval',script],{cwd:process.cwd(),encoding:'utf8',timeout:10000});
  expect(child.error).toBeUndefined();expect(child.status,child.stderr).toBe(0);
  expect(JSON.parse(child.stdout.trim())).toEqual({stop:'CANCELLED',outcome:'ABSTAIN',trace:true,calls:1,tools:0});
 });
});
