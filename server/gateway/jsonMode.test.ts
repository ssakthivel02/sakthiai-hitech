import http from 'node:http';
import type {AddressInfo} from 'node:net';
import {beforeAll,afterAll,beforeEach,describe,it,expect} from 'vitest';
import {buildGatewayFromEnv} from './index';
import {TaskModelTransport} from '../sentinel/taskModelTransport';
let server:http.Server,url:string;let requests:any[]=[];let status=200;
beforeAll(async()=>{server=http.createServer((req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{requests.push(JSON.parse(body));res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(status===200?{choices:[{message:{content:'{"ready":true}'}}]}:{error:{message:'unsupported'}}));});});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));url=`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;});
afterAll(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});
beforeEach(()=>{requests=[];status=200;});
const gateway=(extra:Record<string,string>={})=>buildGatewayFromEnv({LOCAL_LLM_API_URL:url,LOCAL_LLM_MODEL:'test-model',GATEWAY_ALLOW_EXTERNAL:'false',GATEWAY_ALLOW_METERED:'false',GATEWAY_STATE_STORE:'memory',GATEWAY_MAX_ATTEMPTS:'1',...extra});
const req={requestId:'json-mode-test',workspaceId:7,messages:[{role:'user' as const,content:'Return a JSON object.'}]};
describe('request-scoped JSON mode through the existing gateway',()=>{
 it('leaves historical requests unchanged even on an opted-in endpoint',async()=>{expect((await gateway({LOCAL_LLM_JSON_MODE:'true'}).invoke(req)).status).toBe('returned');expect(requests[0]).not.toHaveProperty('response_format');});
 it('transmits JSON mode only for an explicit request and endpoint opt-in',async()=>{expect((await gateway({LOCAL_LLM_JSON_MODE:'true'}).invoke({...req,responseFormat:'json_object'})).status).toBe('returned');expect(requests).toHaveLength(1);expect(requests[0].response_format).toEqual({type:'json_object'});});
 it('does not silently downgrade or send HTTP to an endpoint without opt-in',async()=>{const out=await gateway().invoke({...req,responseFormat:'json_object'});expect(out).toMatchObject({status:'failed',reason:'policy_denied'});expect(requests).toHaveLength(0);});
 it('rejects unknown formats before a request can be sent',async()=>{expect(await gateway({LOCAL_LLM_JSON_MODE:'true'}).invoke({...req,responseFormat:'text' as never})).toMatchObject({status:'failed',reason:'bad_request'});expect(requests).toHaveLength(0);});
 it('surfaces backend rejection without retrying as plain text',async()=>{status=400;expect(await gateway({LOCAL_LLM_JSON_MODE:'true'}).invoke({...req,responseFormat:'json_object'})).toMatchObject({status:'failed',reason:'bad_request'});expect(requests).toHaveLength(1);expect(requests[0].response_format).toEqual({type:'json_object'});});
 it('preserves the Sentinel default while allowing an explicit JSON request',async()=>{let captured:any;const ctx={throwIfCancelled(){},invokeModel:async(r:any)=>{captured=r;return '{}'}};const prompt={system:'Synthetic',user:'Synthetic',attempt:0};await new TaskModelTransport(ctx).complete(prompt);expect(captured).not.toHaveProperty('responseFormat');await new TaskModelTransport(ctx,{jsonMode:true}).complete(prompt);expect(captured.responseFormat).toBe('json_object');});
});
