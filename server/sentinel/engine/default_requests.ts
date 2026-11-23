import type {PolicyView,ToolRequest} from './types';
import {WRITE_TOOLS} from './types';
import {hashOf} from './canon';

export const MAX_DEFAULT_REQUESTS=64;
/** Prompt guidance only: no extra permission, evidence access, tool selection or broker enforcement. */
export function uncachedDefaultRequests(view:PolicyView):{requests:ToolRequest[];omitted:number}{
 if(view.force_final||view.calls_left<=0||view.steps_left<=0||view.virtual_ms_left<=0)return {requests:[],omitted:0};
 const tools=[...new Set(view.case.allowed_tools)].filter(t=>typeof t==='string'&&t.length>0&&t.length<=60&&!(WRITE_TOOLS as readonly string[]).includes(t));
 const targets=[...new Set([...view.case.inventory.services,...view.case.inventory.hosts])].filter(t=>typeof t==='string'&&t.length>0&&t.length<=120&&!/[^\w.\-:]/.test(t));
 const toolSet=new Set(tools),targetSet=new Set(targets),blocked=new Set<string>();
 const key=(tool:string,target:string)=>hashOf({t:tool,g:target,a:null});
 for(const h of view.history)if(h.status!=='DENIED'&&h.request.args==null&&toolSet.has(h.request.tool)&&targetSet.has(h.request.target))blocked.add(key(h.request.tool,h.request.target));
 const requests:ToolRequest[]=[];
 outer:for(const target of targets)for(const tool of tools){
  if(blocked.has(key(tool,target)))continue;
  requests.push({tool,target});if(requests.length===MAX_DEFAULT_REQUESTS)break outer;
 }
 return {requests,omitted:tools.length*targets.length-blocked.size-requests.length};
}
