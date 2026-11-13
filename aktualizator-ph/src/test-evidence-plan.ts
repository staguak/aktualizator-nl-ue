import {EvidenceError,type ExpectedEvidence,type FinalizeEvidencePlan} from './test-evidence.js';
import {validateManualEvidenceRetention,type ManualEvidenceRetention} from './test-evidence-retention.js';

export function manualEvidenceScope(env:NodeJS.ProcessEnv):ManualEvidenceRetention{
  const operation=env.INPUT_RELEASE_OPERATION?.trim();
  const namespace=env.INPUT_TEST_NAMESPACE?.trim()||
    (operation==='initialize'?`release-test-manual-${env.GITHUB_RUN_ID}`:'');
  const value={profile:'manual-update-retention-v1',namespace,operation};
  validateManualEvidenceRetention(value);return value;
}

/** The producer workflow supplies needs/job.status, never the law updater. */
export function evidencePlan(group:string,env:NodeJS.ProcessEnv):FinalizeEvidencePlan{
  const attempt=env.GITHUB_RUN_ATTEMPT;
  if(!/^[1-9]\d*$/.test(attempt??''))throw new EvidenceError('ATTEMPT');
  const raw=JSON.parse(env.LAW_EVIDENCE_JOB_RESULTS??'null');
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new EvidenceError('JOB_RESULTS_REQUIRED');
  const jobs:FinalizeEvidencePlan['jobs']={};
  for(const [name,value]of Object.entries(raw)){
    const result=typeof value==='string'?value:(value as any)?.result;
    if(!/^[A-Za-z0-9_-]+$/.test(name)||!['success','failure','cancelled','skipped'].includes(result))throw new EvidenceError('JOB_RESULT');
    jobs[name]=result;
  }
  const diagnostic=(name:string,job:string,optional=false):ExpectedEvidence=>({name,job,allowPartial:true,...optional?{optional:true}:{}});
  let expected:ExpectedEvidence[],requiredJobs:string[],retention:ManualEvidenceRetention|undefined;
  if(group==='evidence-release-tests'){
    expected=[diagnostic(`release-foundation-corpus-diagnostics-${attempt}`,'verify')];requiredJobs=['verify'];
    if(env.LAW_EVIDENCE_SCOPE==='benchmark'){
      requiredJobs.push('benchmark_prepare','benchmark_full','benchmark_incremental');
      expected.push({name:`matched-benchmark-fixture-${attempt}`,job:'benchmark_prepare'},
        {name:`matched-benchmark-prepare-${attempt}`,job:'benchmark_prepare'},
        {name:`matched-benchmark-full-${attempt}`,job:'benchmark_full'},
        {name:`matched-benchmark-incremental-${attempt}`,job:'benchmark_incremental'});
    }else if(!['full','technical','source-check','finalize','diagnostic'].includes(env.LAW_EVIDENCE_SCOPE??''))throw new EvidenceError('SCOPE');
  }else if(group==='evidence-official-tests'){
    requiredJobs=['verify'];expected=[{name:'verify-paczkaNL',job:'verify'},{name:'verify-paczkaUE',job:'verify'},
      diagnostic('xml-validation-evidence','verify'),diagnostic('official-source-diagnostics','verify',true)];
  }else if(group==='evidence-publication'){
    requiredJobs=['validate'];expected=[diagnostic(`paired-release-diagnostics-${attempt}`,'validate')];
  }else if(group==='evidence-manual-tests'){
    requiredJobs=['validate'];expected=[diagnostic(`manual-release-diagnostics-${attempt}`,'validate')];
    retention=manualEvidenceScope(env);
  }else{
    expected=JSON.parse(env.LAW_EVIDENCE_EXPECTED??'null');requiredJobs=JSON.parse(env.LAW_EVIDENCE_REQUIRED_JOBS??'null');
    if(!Array.isArray(expected)||!Array.isArray(requiredJobs))throw new EvidenceError('EXPLICIT_PLAN_REQUIRED');
  }
  return {expected,requiredJobs,jobs,sequence:Number(env.GITHUB_RUN_NUMBER),
    protected:env.LAW_EVIDENCE_PRESERVE!=='0'||!!retention&&!['initialize','update'].includes(retention.operation),
    ...retention?{retention}:{}};
}
