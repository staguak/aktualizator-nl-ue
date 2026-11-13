/** Only new disposable evidence receipts are eligible. Legacy/source namespaces
 * and acceptance evidence are never inferred disposable from their names. */
export interface ManualEvidenceRetention {
  profile:'manual-update-retention-v1';
  namespace:string;
  operation:'initialize'|'update'|'check'|'rollback'|'recover';
}
export function validateManualEvidenceRetention(value:unknown):asserts value is ManualEvidenceRetention{
  const v=value as ManualEvidenceRetention;
  if(!v||v.profile!=='manual-update-retention-v1'||
    typeof v.namespace!=='string'||v.namespace.length>80||!/^release-test-manual-[1-9]\d*$/.test(v.namespace)||
    !['initialize','update','check','rollback','recover'].includes(v.operation)||
    Object.keys(v).some(k=>!['profile','namespace','operation'].includes(k)))throw new Error('Ambiguous manual evidence scope');
}
export interface TestEvidenceRun {id:string;logicalUpdate?:string;sequence:number;status:'PASS'|'FAIL';protected:boolean;active:boolean;retention?:ManualEvidenceRetention}
export function obsoleteTestEvidence(runs:TestEvidenceRun[]):string[]{
  if(new Set(runs.map(r=>r.id)).size!==runs.length||
    runs.some(r=>!/^\d+-\d+$/.test(r.id)||!Number.isSafeInteger(r.sequence)||r.sequence<1||
      !['PASS','FAIL'].includes(r.status)||typeof r.active!=='boolean'||typeof r.protected!=='boolean'))
    throw new Error('Ambiguous evidence history');
  for(const run of runs)if(run.retention!==undefined)validateManualEvidenceRetention(run.retention);
  const groups=new Map<string,TestEvidenceRun[]>();
  for(const run of runs){const logical=run.logicalUpdate??run.id.split('-')[0];
    if(!/^[1-9]\d*$/.test(logical)||logical!==run.id.split('-')[0])throw new Error('Ambiguous logical update');
    groups.set(logical,[...(groups.get(logical)??[]),run]);}
  // A rerun cannot silently change operation or corpus and retire older evidence.
  for(const rows of groups.values())if(rows.some(r=>r.retention?.namespace!==rows[0].retention?.namespace||
    r.retention?.operation!==rows[0].retention?.operation))throw new Error('Ambiguous manual update attempts');
  const completed=[...groups.entries()].filter(([,rows])=>
    (!rows[0].retention||['initialize','update'].includes(rows[0].retention.operation))&&
    rows.every(r=>!r.active)&&rows.some(r=>r.status==='PASS'));
  if(completed.some(([,rows])=>new Set(rows.map(r=>r.sequence)).size!==1)||
    new Set(completed.map(([,rows])=>rows[0].sequence)).size!==completed.length)throw new Error('Ambiguous update order');
  completed.sort((a,b)=>b[1][0].sequence-a[1][0].sequence);
  // New manual evidence is counted per corpus. Checks/rollback/recovery never
  // advance update age, and legacy receipts cannot age a newly scoped corpus.
  const retainedPerScope=new Map<string,number>(),latest=new Set<string>();
  for(const [id,rows] of completed){const scope=rows[0].retention?.namespace??'legacy';
    const count=retainedPerScope.get(scope)??0;
    if(count<2)latest.add(id);retainedPerScope.set(scope,count+1);}
  return completed.filter(([id,rows])=>!latest.has(id)&&rows.every(r=>r.status==='PASS'&&!r.protected&&!r.active))
    .flatMap(([,rows])=>rows.map(r=>r.id));
}
