import {describe,it,expect,vi} from 'vitest';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,existsSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {qualifyLocalSentinelModel} from './localReadiness';
import {LOCAL_PROVIDER_ID} from '../gateway/config';
import type {GatewayOutcome,GatewayRequest} from '../gateway/types';
const abstain={type:'FINAL',outcome:'ABSTAIN',label:'INCONCLUSIVE',summary:'No evidence supplied.',cited:[],contradictions:[],confidence:0,remediation_proposal:'No change proposed.',next_safe_steps:['Supply an incident before investigating.'],hypotheses:[]};
const returned=(content:string):GatewayOutcome=>({status:'returned',content,providerId:LOCAL_PROVIDER_ID,modelId:'test',profileId:'sakthi-local-general',kind:'self_hosted',billingMode:'local_compute',usage:{source:'none'},attempts:[],latencyMs:1});
const port=(replies:GatewayOutcome[])=>({invoke:vi.fn(async(_r:GatewayRequest)=>{const x=replies.shift();if(!x)throw Error('extra call');return x;})});
describe('bounded local Sentinel readiness',()=>{
 it('does not count a partial prime as readiness; qualifies only the second safe contract',async()=>{const p=port([returned('{'),returned(JSON.stringify(abstain))]);const out=await qualifyLocalSentinelModel(p,{workspaceId:7,jsonMode:true});expect(out).toMatchObject({ready:true,logicalCalls:2,scope:'LOCAL_MODEL_CONTRACT_ONLY'});expect(p.invoke.mock.calls.map(([r])=>r.maxOutputTokens)).toEqual([1,256]);expect(p.invoke.mock.calls.every(([r])=>r.responseFormat==='json_object')).toBe(true);expect(p.invoke.mock.calls[0]![0].requestId).not.toBe(p.invoke.mock.calls[1]![0].requestId);expect(p.invoke.mock.calls[0]![0].messages).toEqual(p.invoke.mock.calls[1]![0].messages);});
 it('retains plain mode when not explicitly requested',async()=>{const p=port([returned('{'),returned(JSON.stringify(abstain))]);await qualifyLocalSentinelModel(p,{workspaceId:7});expect(p.invoke.mock.calls.every(([r])=>r.responseFormat===undefined)).toBe(true);});
 it('stops after a failed prime without retries or tool execution',async()=>{const p=port([{status:'failed',reason:'timeout',attempts:[],latencyMs:60000}]);expect(await qualifyLocalSentinelModel(p,{workspaceId:7})).toMatchObject({ready:false,logicalCalls:1,reason:'PROVIDER_timeout'});expect(p.invoke).toHaveBeenCalledTimes(1);});
 it('does not continue after a non-local outcome',async()=>{const p=port([{...returned('{}'),kind:'external',billingMode:'metered_api'} as GatewayOutcome]);expect(await qualifyLocalSentinelModel(p,{workspaceId:7})).toMatchObject({ready:false,reason:'NON_LOCAL_OUTCOME'});expect(p.invoke).toHaveBeenCalledTimes(1);});
 it.each([['malformed','oops'],['tool request',JSON.stringify({type:'CALL',tool:'logs.search',target:'x',rationale:'read',hypotheses:[]})],['unknown citation',JSON.stringify({...abstain,cited:['missing']})],['false execution',JSON.stringify({...abstain,abstain_reason:'Sentinel restarted the service.'})],['URL',JSON.stringify({...abstain,abstain_reason:'See https://example.invalid'})],['invented hypothesis',JSON.stringify({...abstain,hypotheses:[{label:'DISK_FULL',status:'ACTIVE',score:0.8,supporting:[]}]})]])('refuses readiness for %s',async(_label,text)=>{expect(await qualifyLocalSentinelModel(port([returned('{'),returned(text!)]),{workspaceId:7})).toMatchObject({ready:false,logicalCalls:2});});
 it('preserves input before sending and sends nothing if preservation fails',async()=>{const p=port([]);await expect(qualifyLocalSentinelModel(p,{workspaceId:7,record:()=>{throw Error('disk failure')}})).rejects.toThrow('disk failure');expect(p.invoke).not.toHaveBeenCalled();});
 it.each(['https://example.invalid/v1','http://10.0.0.1:8897/v1','http://user:never-log-this@127.0.0.1:8897/v1'])('CLI refuses unsafe endpoint before creating evidence or inference: %s',(url)=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'sentinel-ready-'));try{const out=path.join(dir,'evidence');const p=spawnSync(process.execPath,['node_modules/tsx/dist/cli.mjs','scripts/sentinel-local-readiness.ts',out],{cwd:process.cwd(),env:{...process.env,LOCAL_LLM_API_URL:url,LOCAL_LLM_MODEL:'test'},encoding:'utf8',timeout:10000});expect(p.status).toBe(1);expect(p.stdout+p.stderr).not.toContain('never-log-this');expect(existsSync(out)).toBe(false);}finally{rmSync(dir,{recursive:true,force:true});}
 });
 it('refuses invalid workspace before any request',async()=>{const p=port([]);await expect(qualifyLocalSentinelModel(p,{workspaceId:0})).rejects.toThrow('workspaceId');expect(p.invoke).not.toHaveBeenCalled();});
});
