import {describe,it,expect} from 'vitest';
import {TraceBuilder} from './engine/trace';
import {buildView} from './view';
import {buildReport,renderHtml,renderMarkdown} from './report';
import {summaryFromEvents} from './replay';
import {ID,newRow} from './testkit';
import type {InvestigationRecord} from './types';
const warning='LEADER_CHANGE_WITHOUT_NEW_EVIDENCE:none->MISSING_PERMISSION';
function reportFrom(sources:Array<'revision'|'check'|'reject'>){
 const t=new TraceBuilder(ID);t.add('run_start',0,{allowed_tools:[]});
 for(const source of sources){
  if(source==='revision')t.add('hypothesis_revision',0,{step:1,leader_before:null,leader_after:'MISSING_PERMISSION',leader_changed:true,leader_basis:'prior',new_evidence:[],changes:[],justified:false,warnings:[warning]});
  else if(source==='check')t.add('ledger_check',0,{warnings:[warning]});
  else t.add('ledger_reject',0,{rejected_label:'MISSING_PERMISSION',blocking:[warning,'<script>untrusted-warning</script>']});
 }
 t.add('final',0,{outcome:'ABSTAIN',label:'INCONCLUSIVE',summary:'No conclusion drawn.',cited:[],contradictions:[],confidence:0,remediation:{text:'No change proposed.',executed:false,requires_approval:true},next_safe_steps:[]});
 t.add('run_end',0,{stop_reason:sources.includes('reject')?'LEDGER_REJECTED':'POLICY_FINAL',steps:1,stats:{}});
 const at=new Date('2026-11-28T00:00:00Z');const row:InvestigationRecord={...newRow(),...summaryFromEvents(t.events)!,taskId:null,createdAt:at,updatedAt:at,startedAt:at,finishedAt:at};return buildReport(buildView(row,t.events));
}
describe('recorded ledger warning explanations survive report projection',()=>{
 it('shows revision warnings without inventing a rejection',()=>{
  const r=reportFrom(['revision']);expect(r.integrity.chainOk).toBe(true);expect(r.verification?.passed).toBe(true);expect(r.verification?.ledgerWarnings).toEqual([warning]);expect(renderMarkdown(r)).toContain(warning);
 });
 it('shows blocking rejection reasons even without a final ledger_check event',()=>{
  const r=reportFrom(['reject']);expect(r.verification?.passed).toBe(false);expect(r.verification?.ledgerWarnings).toContain(warning);expect(renderHtml(r)).toContain('LEADER_CHANGE_WITHOUT_NEW_EVIDENCE:none-&gt;MISSING_PERMISSION');expect(r.conclusion?.outcome).toBe('ABSTAIN');
 });
 it('deduplicates warnings across sources and escapes untrusted rejection text',()=>{
  const r=reportFrom(['revision','check','reject']);expect(r.verification?.ledgerWarnings).toEqual([warning,'<script>untrusted-warning</script>']);const html=renderHtml(r);expect(html).toContain('&lt;script&gt;untrusted-warning&lt;/script&gt;');expect(html).not.toContain('<script>untrusted-warning</script>');
 });
});
