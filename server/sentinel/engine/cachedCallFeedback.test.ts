import {describe,it,expect} from 'vitest';
import {GatewayPolicy} from './gateway_policy';
import {MockModelTransport} from './model_transport';
import {investigateAsync} from './orchestrator';
import {FakeTools,newRow} from '../testkit';
import {caseFromRecord} from '../caseDoc';
import {DEFAULT_TAXONOMY} from '../taxonomy';
import type {PolicyView,ToolRequest,ToolResult,CallStatus} from './types';
const req:ToolRequest={tool:'logs.search',target:'orders-db'};
const previous=(request=req,status:CallStatus='OK'):ToolResult=>({seq:0,request,status,records:[],quarantined:[],attempts:1,replayed:false,virtual_ms:1,result_hash:'fixture'});
const view=(history:ToolResult[]):PolicyView=>({case:caseFromRecord(newRow() as never),history,calls_left:4,steps_left:8,virtual_ms_left:10000,force_final:false,taxonomy:{...DEFAULT_TAXONOMY}});
const call=(request=req)=>JSON.stringify({type:'CALL',...request,rationale:'Read authorized evidence',hypotheses:[]});
const abstain=JSON.stringify({type:'FINAL',outcome:'ABSTAIN',label:'INCONCLUSIVE',summary:'Evidence remains insufficient',cited:[],confidence:0,remediation_proposal:'No change proposed',next_safe_steps:[],hypotheses:[]});
const cachedReason='request already cached: choose a different authorized read or FINAL';
describe('model cached-call feedback within existing retry budget',()=>{
 it.each(['OK','NO_DATA','ERROR','TIMEOUT'] as const)('rejects an exact previously cached %s request',(status)=>{
  const t=new MockModelTransport(()=>call());const p=new GatewayPolicy(t,{maxModelCalls:2,formatRetries:0});return expect(p.next(view([previous(req,status)]))).rejects.toThrow(cachedReason);
 });
 it('offers feedback and lets the model select a different diagnostic',async()=>{
  const next={tool:'metrics.query',target:'db-1'};const t=new MockModelTransport((_r,n)=>n===0?call():call(next));const p=new GatewayPolicy(t,{maxModelCalls:2,formatRetries:1});
  const d=await p.next(view([previous()]));expect(d.type).toBe('CALL');if(d.type==='CALL')expect(d.request).toEqual(next);
  expect(t.calls).toHaveLength(2);expect(t.calls[1]!.user).toContain(cachedReason);expect(d.model_meta?.model_calls).toBe(2);
 });
 it('treats reordered argument keys exactly as the broker cache does',async()=>{
  const before={...req,args:{query:'errors',window_min:5}},again={...req,args:{window_min:5,query:'errors'}};
  const t=new MockModelTransport((_r,n)=>n===0?call(again):abstain);const d=await new GatewayPolicy(t,{maxModelCalls:2,formatRetries:1}).next(view([previous(before)]));expect(d.type).toBe('FINAL');expect(t.calls).toHaveLength(2);
 });
 it.each([{...req,args:{query:'another filter'}},{...req,target:'db-1'},{...req,args:{}}])('preserves distinct broker request identity %j',async(request)=>{
  const t=new MockModelTransport(()=>call(request));const d=await new GatewayPolicy(t,{maxModelCalls:1}).next(view([previous()]));expect(d.type).toBe('CALL');expect(t.calls).toHaveLength(1);
 });
 it('does not treat denied requests as cached executions',async()=>{
  const t=new MockModelTransport(()=>call());const d=await new GatewayPolicy(t,{maxModelCalls:1}).next(view([previous(req,'DENIED')]));expect(d.type).toBe('CALL');expect(t.calls).toHaveLength(1);
 });
 it('stops at the existing logical call cap instead of adding a feedback call',async()=>{
  const t=new MockModelTransport(()=>call());await expect(new GatewayPolicy(t,{maxModelCalls:1,formatRetries:3}).next(view([previous()]))).rejects.toThrow('MODEL_CALL_BUDGET_EXHAUSTED');expect(t.calls).toHaveLength(1);
 });
 it('does not echo rejected rationale text or mutate history',async()=>{
  const history=[previous()],before=structuredClone(history);const marker='private-rejected-rationale-marker';const t=new MockModelTransport((_r,n)=>n===0?JSON.stringify({type:'CALL',...req,rationale:marker,hypotheses:[]}):abstain);
  await new GatewayPolicy(t,{maxModelCalls:2,formatRetries:1}).next(view(history));expect(t.calls).toHaveLength(2);expect(t.calls[1]!.user).not.toContain(marker);expect(history).toEqual(before);
 });
 it('runs the real engine with two diagnostic executions and no broker replay after feedback',async()=>{
  const tools=new FakeTools();const t=new MockModelTransport((_r,n)=>n===0||n===1?call():n===2?call({tool:'metrics.query',target:'db-1'}):abstain);
  const result=await investigateAsync(caseFromRecord(newRow() as never),{policy:new GatewayPolicy(t,{maxModelCalls:4,formatRetries:1}),transport:tools,taxonomy:{...DEFAULT_TAXONOMY},verify:{requireSignatureSupport:false,signatureKb:'off'}});
  expect(t.calls).toHaveLength(4);expect(tools.calls.map(c=>c.tool)).toEqual(['logs.search','metrics.query']);expect(result.stats.duplicates_suppressed).toBe(0);expect(result.trace_ok).toBe(true);expect(result.final.outcome).toBe('ABSTAIN');
 });
});
