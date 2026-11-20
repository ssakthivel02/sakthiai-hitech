// Operator-only local model preflight. No tools, SQL, external providers or production readiness flags.
import {mkdirSync,writeFileSync,appendFileSync} from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {buildGatewayFromEnv} from '../server/gateway';
import {qualifyLocalSentinelModel} from '../server/sentinel/localReadiness';
async function main(){
 const out=process.argv[2];if(!out)throw new Error('usage: tsx scripts/sentinel-local-readiness.ts NEW_EVIDENCE_DIRECTORY');
 const url=new URL(process.env.LOCAL_LLM_API_URL??'');
 if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password||url.search||url.hash)throw new Error('a credential-free loopback model URL is required');
 const model=process.env.LOCAL_LLM_MODEL?.trim();if(!model)throw new Error('LOCAL_LLM_MODEL required');
 const env={LOCAL_LLM_API_URL:url.toString(),LOCAL_LLM_MODEL:model,LOCAL_LLM_API_KEY:process.env.LOCAL_LLM_API_KEY,LOCAL_LLM_JSON_MODE:process.env.LOCAL_LLM_JSON_MODE?.trim().toLowerCase()==='true'?'true':'false',GATEWAY_ALLOW_EXTERNAL:'false',GATEWAY_ALLOW_METERED:'false',GATEWAY_STATE_STORE:'memory',GATEWAY_MAX_ATTEMPTS:'1',GATEWAY_TIMEOUT_MS:'60000',GATEWAY_TOTAL_DEADLINE_MS:'60000'};
 const workspaceId=Number(process.env.SENTINEL_READINESS_WORKSPACE_ID??7),jsonMode=process.env.SENTINEL_JSON_MODE==='true';
 if(!Number.isSafeInteger(workspaceId)||workspaceId<1)throw new Error('positive readiness workspace ID required');
 mkdirSync(out); // exclusive directory: never mix a new qualification with historical events
 writeFileSync(path.join(out,'input.json'),JSON.stringify({scope:'Operator preflight only, not incident/worker/hosted readiness',head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),model,endpointOrigin:url.origin,workspaceId,jsonMode,endpointJsonMode:env.LOCAL_LLM_JSON_MODE==='true',maxCalls:2,perCallDeadlineMs:60000,startedAt:new Date().toISOString()},null,2),{flag:'wx'});
 const result=await qualifyLocalSentinelModel(buildGatewayFromEnv(env),{workspaceId,jsonMode,record:event=>appendFileSync(path.join(out,'events.jsonl'),JSON.stringify(event)+'\n')});
 writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2),{flag:'wx'});console.log(JSON.stringify(result));if(!result.ready)process.exitCode=1;
}
main().catch(()=>{console.error('LOCAL_READINESS_FAILED: inspect configuration and retained evidence; no readiness granted');process.exitCode=1;});
