import http from 'node:http';
import type {AddressInfo} from 'node:net';
import {beforeAll,afterAll,beforeEach,describe,it,expect} from 'vitest';
import {buildGatewayFromEnv,loadGatewayConfig,createProviderGateway,createOpenAiCompatibleAdapter} from './index';
let server:http.Server,url:string;let requests:any[]=[];let status=200;
beforeAll(async()=>{server=http.createServer((req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{requests.push(JSON.parse(body));res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(status===200?{choices:[{message:{content:'{"choice":"READ_ONLY"}'}}]}:{error:{message:'unsupported schema'}}));});});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));url=`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;});
afterAll(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});
beforeEach(()=>{requests=[];status=200;});
const gateway=(extra:Record<string,string>={})=>buildGatewayFromEnv({LOCAL_LLM_API_URL:url,LOCAL_LLM_MODEL:'test-model',LOCAL_LLM_JSON_MODE:'true',GATEWAY_ALLOW_EXTERNAL:'false',GATEWAY_ALLOW_METERED:'false',GATEWAY_STATE_STORE:'memory',GATEWAY_MAX_ATTEMPTS:'1',...extra});
const req={requestId:'schema-wire-test',workspaceId:7,messages:[{role:'user' as const,content:'Return a JSON object.'}],responseFormat:'json_object' as const};
const schema={type:'object',properties:{choice:{type:'string',enum:['READ_ONLY','ABSTAIN']}},required:['choice'],additionalProperties:false};
describe('explicit local llama-compatible schema forwarding',()=>{
 it('forwards the exact schema only with request and endpoint opt-in',async()=>{expect((await gateway({LOCAL_LLM_LLAMA_JSON_SCHEMA:'true'}).invoke({...req,responseSchema:schema})).status).toBe('returned');expect(requests).toHaveLength(1);expect(requests[0].response_format).toEqual({type:'json_object',schema});});
 it('preserves plain JSON mode when a schema is not requested',async()=>{expect((await gateway({LOCAL_LLM_LLAMA_JSON_SCHEMA:'true'}).invoke(req)).status).toBe('returned');expect(requests[0].response_format).toEqual({type:'json_object'});});
 it('refuses schema requests before HTTP when the endpoint has not opted in',async()=>{expect(await gateway().invoke({...req,responseSchema:schema})).toMatchObject({status:'failed',reason:'policy_denied'});expect(requests).toHaveLength(0);});
 it('still requires JSON-object mode even if schema support alone is enabled',async()=>{expect(await gateway({LOCAL_LLM_LLAMA_JSON_SCHEMA:'true',LOCAL_LLM_JSON_MODE:'false'}).invoke({...req,responseSchema:schema})).toMatchObject({status:'failed',reason:'policy_denied'});expect(requests).toHaveLength(0);});
 it('rejects schemas without an explicit JSON-object request',async()=>{const {responseFormat,...plain}=req;expect(await gateway({LOCAL_LLM_LLAMA_JSON_SCHEMA:'true'}).invoke({...plain,responseSchema:schema})).toMatchObject({status:'failed',reason:'bad_request'});expect(requests).toHaveLength(0);});
 it('rejects non-object, oversized, cyclic and non-JSON schema envelopes before HTTP',async()=>{
  const cycle:any={type:'object'};cycle.self=cycle;let deep:any={type:'string'};for(let i=0;i<20;i++)deep={properties:{next:deep}};
  for(const invalid of [null,[],true,{description:'x'.repeat(32769)},cycle,deep,{bad:undefined},{bad:()=>0}])expect(await gateway({LOCAL_LLM_LLAMA_JSON_SCHEMA:'true'}).invoke({...req,responseSchema:invalid as never})).toMatchObject({status:'failed',reason:'bad_request'});
  expect(requests).toHaveLength(0);
 });
 it('refuses remote schema references and allows local definitions',async()=>{
  for(const key of ['$ref','$dynamicRef','$recursiveRef'])expect(await gateway({LOCAL_LLM_LLAMA_JSON_SCHEMA:'true'}).invoke({...req,responseSchema:{[key]:'https://example.invalid/schema'}})).toMatchObject({status:'failed',reason:'bad_request'});
  expect(requests).toHaveLength(0);const local={type:'object',$defs:{choice:schema},properties:{value:{$ref:'#/$defs/choice'}}};expect((await gateway({LOCAL_LLM_LLAMA_JSON_SCHEMA:'true'}).invoke({...req,responseSchema:local})).status).toBe('returned');expect(requests[0].response_format.schema).toEqual(local);
 });
 it('rejects accessor schemas without executing their getters',async()=>{let reads=0;const accessor=Object.defineProperty({},'type',{enumerable:true,get(){reads++;return 'object'}});expect(await gateway({LOCAL_LLM_LLAMA_JSON_SCHEMA:'true'}).invoke({...req,responseSchema:accessor})).toMatchObject({status:'failed',reason:'bad_request'});expect(reads).toBe(0);expect(requests).toHaveLength(0);});
 it('never treats an external binding as eligible for the local schema extension',async()=>{const config=loadGatewayConfig({LOCAL_LLM_API_URL:url,LOCAL_LLM_MODEL:'test-model',LOCAL_LLM_JSON_MODE:'true',LOCAL_LLM_LLAMA_JSON_SCHEMA:'true',GATEWAY_ALLOW_EXTERNAL:'true',GATEWAY_STATE_STORE:'memory'});config.bindings[0]!.kind='external';let adapters=0;const gw=createProviderGateway(config,{adapterFactory:()=>{adapters++;throw Error('must not construct an adapter')}});expect(await gw.invoke({...req,responseSchema:schema})).toMatchObject({status:'failed',reason:'policy_denied'});expect(adapters).toBe(0);expect(requests).toHaveLength(0);});
 it('enforces the opt-in at the adapter boundary as well',async()=>{const adapter=createOpenAiCompatibleAdapter({providerId:'test',baseUrl:url,jsonMode:true,maxAttempts:1});await expect(adapter.complete({messages:req.messages,model:'test',responseFormat:'json_object',responseSchema:schema})).rejects.toMatchObject({errorClass:'bad_request'});expect(requests).toHaveLength(0);});
 it('retains endpoint schema rejection without retrying as unconstrained JSON',async()=>{status=400;expect(await gateway({LOCAL_LLM_LLAMA_JSON_SCHEMA:'true'}).invoke({...req,responseSchema:schema})).toMatchObject({status:'failed',reason:'bad_request'});expect(requests).toHaveLength(1);expect(requests[0].response_format.schema).toEqual(schema);});
});
