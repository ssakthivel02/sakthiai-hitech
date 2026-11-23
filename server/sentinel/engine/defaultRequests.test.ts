import assert from 'node:assert/strict';
import {it} from 'vitest';
import {buildPrompt} from './llm_contract';
import {uncachedDefaultRequests,MAX_DEFAULT_REQUESTS} from './default_requests';
import {Broker} from './broker';
import {FakeTools,newRow} from '../testkit';
import {caseFromRecord} from '../caseDoc';
import type {PolicyView,ToolResult} from './types';
const base:PolicyView={case:caseFromRecord(newRow({inventory:{services:['demo'],hosts:[]},allowedTools:['logs.search','config.get']})),history:[],taxonomy:{INCONCLUSIVE:'insufficient'},calls_left:4,steps_left:8,virtual_ms_left:30000,force_final:false};
const history=(over:Partial<ToolResult>={}):ToolResult=>({seq:1,request:{tool:'logs.search',target:'demo'},status:'OK',records:[],quarantined:[],attempts:1,replayed:false,virtual_ms:1,result_hash:'control',...over});
function check(name:string,run:()=>void){it(name,run);}
check('initial declared default requests only',()=>assert.deepEqual(uncachedDefaultRequests(base),{requests:[{tool:'logs.search',target:'demo'},{tool:'config.get',target:'demo'}],omitted:0}));
check('cached completed statuses remove exact default request',()=>{for(const status of ['OK','NO_DATA','ERROR','TIMEOUT'] as const)assert.deepEqual(uncachedDefaultRequests({...base,history:[history({status})]}).requests,[{tool:'config.get',target:'demo'}]);});
check('explicit empty or query args do not hide distinct default cache identity',()=>{for(const args of [{},{query:'different'}])assert.equal(uncachedDefaultRequests({...base,history:[history({request:{tool:'logs.search',target:'demo',args}})]}).requests.length,2);});
check('denials are not treated as cached observations',()=>assert.equal(uncachedDefaultRequests({...base,history:[history({status:'DENIED'})]}).requests.length,2));
check('write names, duplicate scopes and invalid target formats never become options',()=>{const v=structuredClone(base);v.case.allowed_tools=['logs.search','logs.search','service.restart'];v.case.inventory={services:['demo','demo','bad target'],hosts:['demo']};assert.deepEqual(uncachedDefaultRequests(v).requests,[{tool:'logs.search',target:'demo'}]);});
check('foreign history cannot introduce another tool or target',()=>{assert.equal(uncachedDefaultRequests({...base,history:[history({request:{tool:'foreign.read',target:'other-tenant'}})]}).requests.length,2);});
check('final and exhausted budgets expose no requests',()=>{for(const delta of [{force_final:true},{calls_left:0},{steps_left:0},{virtual_ms_left:0}])assert.deepEqual(uncachedDefaultRequests({...base,...delta}),{requests:[],omitted:0});});
check('bounded list discloses omitted eligible options',()=>{const v=structuredClone(base);v.case.inventory.services=Array.from({length:40},(_,i)=>'service-'+i);const r=uncachedDefaultRequests(v);assert.equal(r.requests.length,MAX_DEFAULT_REQUESTS);assert.equal(r.omitted,80-MAX_DEFAULT_REQUESTS);});
check('request descriptions and inputs remain isolated',()=>{const v=structuredClone(base),before=structuredClone(v);const r=uncachedDefaultRequests(v);r.requests[0]!.tool='changed';assert.deepEqual(v,before);});
it('every default option is admitted by the actual async broker and disappears after caching',async()=>{
 const broker=new Broker(base.case,new FakeTools());
 for(const request of uncachedDefaultRequests(base).requests){const result=await broker.callAsync(request);assert.notEqual(result.status,'DENIED');assert.equal(result.replayed,false);}
 assert.deepEqual(uncachedDefaultRequests({...base,history:broker.results}),{requests:[],omitted:0});
});
it('exposes fresh options in the model view without replacing other requests or deciding a conclusion',()=>{
 const v={...base,history:[history()]};const prompt=buildPrompt(v),visible=JSON.parse(prompt.user);
 assert.deepEqual(visible.tool_policy.uncached_default_requests,[{tool:'config.get',target:'demo'}]);
 assert.equal(visible.tool_policy.uncached_default_requests_omitted,0);
 assert.deepEqual(visible.case.allowed_tools,base.case.allowed_tools);
 assert.equal(visible.history.length,1);
 assert.match(prompt.system,/uncached_default_requests/);
 assert.match(prompt.system,/different valid args/);
 assert.equal(Object.hasOwn(visible.tool_policy,'diagnosis'),false);
});
it('keeps earlier evidence in the reusable prefix when budgets and available requests change',()=>{
 const record={rid:'prefix-record',obs_id:'prefix-observation',ts:'2026-11-20T00:00:00Z',level:'INFO',text:'Stable evidence prefix',quarantined:false};
 const first={...base,calls_left:3,history:[history({records:[record]})]};
 const later={...base,calls_left:2,history:[...first.history,history({seq:2,request:{tool:'config.get',target:'demo'}})]};
 const before=buildPrompt(first).user,after=buildPrompt(later).user,marker='"text":"Stable evidence prefix"';
 assert(before.includes(marker));let common=0;while(common<before.length&&before[common]===after[common])common++;
 assert(common>=before.indexOf(marker)+marker.length,'Changing request guidance evicted the earlier evidence prefix');
});
