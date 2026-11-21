import {randomUUID} from 'node:crypto';
import {buildPrompt,parseDecision} from './engine/llm_contract';
import {verifyFinal} from './engine/verifier';
import {DEFAULT_TAXONOMY} from './taxonomy';
import {sha256} from './engine/canon';
import {LOCAL_PROVIDER_ID} from '../gateway/config';
import type {GatewayOutcome,GatewayRequest} from '../gateway/types';
import type {PolicyView} from './engine/types';

export type ReadinessEvent = {phase:'prime'|'qualify';request:GatewayRequest;outcome?:GatewayOutcome};
export type LocalReadinessResult = {ready:boolean;scope:'LOCAL_MODEL_CONTRACT_ONLY';reason:string;systemPromptSha256:string;logicalCalls:number;elapsedMs:number};
/** Operator preflight only. Does not enqueue work, execute tools, update app readiness or establish incident accuracy. */
export async function qualifyLocalSentinelModel(gateway:{invoke(request:GatewayRequest):Promise<GatewayOutcome>}, options:{workspaceId:number;jsonMode?:boolean;record?:(event:ReadinessEvent)=>void|Promise<void>}):Promise<LocalReadinessResult>{
  if(!Number.isSafeInteger(options.workspaceId)||options.workspaceId<1)throw new Error('positive workspaceId required');
  const start=Date.now();let calls=0;
  const view:PolicyView={case:{case_id:'local-model-readiness',tenant:`ws-${options.workspaceId}`,objective:'This is a readiness check, not an incident. No evidence or diagnostic tools are available. Return a safe abstention; do not request a tool or claim any action.',alert:{title:'No incident supplied',severity:'info',service:'readiness-only',fired_at:new Date(start).toISOString(),description:'No failure or customer data supplied.'},operator_notes:[],inventory:{services:[],hosts:[]},allowed_tools:[],limits:{max_tool_calls:0,max_steps:1,max_retries_per_call:0,max_virtual_ms:120000}},history:[],calls_left:0,steps_left:1,virtual_ms_left:120000,force_final:true,taxonomy:{...DEFAULT_TAXONOMY}};
  const prompt=buildPrompt(view),systemPromptSha256=sha256(prompt.system),prefix=randomUUID();
  const finish=(ready:boolean,reason:string):LocalReadinessResult=>({ready,scope:'LOCAL_MODEL_CONTRACT_ONLY',reason,systemPromptSha256,logicalCalls:calls,elapsedMs:Date.now()-start});
  for(const phase of ['prime','qualify'] as const){
    const request:GatewayRequest={requestId:`sentinel-readiness:${prefix}:${phase}`,workspaceId:options.workspaceId,messages:[{role:'system',content:prompt.system},{role:'user',content:prompt.user}],intents:['analysis'],requiredCapabilities:['chat','reasoning'],optionalCapabilities:['structured_output'],maxOutputTokens:phase==='prime'?1:256,...(options.jsonMode?{responseFormat:'json_object' as const}:{})};
    await options.record?.({phase,request}); // failure to preserve the input sends no request
    let outcome:GatewayOutcome;
    calls++;
    try{outcome=await gateway.invoke(request);}catch{return finish(false,'GATEWAY_ERROR');}
    await options.record?.({phase,request,outcome});
    if(outcome.status!=='returned')return finish(false,`PROVIDER_${outcome.reason}`);
    if(outcome.providerId!==LOCAL_PROVIDER_ID||outcome.kind!=='self_hosted'||outcome.billingMode!=='local_compute')return finish(false,'NON_LOCAL_OUTCOME');
    if(phase==='prime')continue; // a one-token prefix is deliberately incomplete and never qualifies readiness
    try{
      const decision=parseDecision(outcome.content,view);
      if(decision.type!=='FINAL'||decision.final.outcome!=='ABSTAIN'||decision.final.label!=='INCONCLUSIVE'||decision.final.cited.length||decision.final.contradictions.length||decision.hypotheses.length)return finish(false,'UNSAFE_PREFLIGHT_DECISION');
      const verified=verifyFinal(decision.final,view.case,new Map(),view.taxonomy,{requireSignatureSupport:false,signatureKb:'off'});
      if(!verified.ok||verified.redactions.length)return finish(false,'UNSAFE_PREFLIGHT_OUTPUT');
      return finish(true,'SAFE_ABSTENTION_RECEIVED');
    }catch{return finish(false,'INVALID_PREFLIGHT_CONTRACT');}
  }
  return finish(false,'INCOMPLETE');
}
