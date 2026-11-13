/** Managed test evidence only; no production release or GitHub artifact I/O. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {google} from 'googleapis';
import {authorizeDrive} from '../src/drive-auth.js';
import {DriveReleaseStore} from '../src/drive-release-store.js';
import {safeCacheDirectory} from '../src/cache-directory.js';
import {obsoleteTestEvidence} from '../src/test-evidence-retention.js';
import {evidencePlan,manualEvidenceScope} from '../src/test-evidence-plan.js';
import {EvidenceError,validateEvidenceIdentity,validateEvidencePlan,saveEvidenceBundle,readEvidenceBundle,finalizeEvidence,
  evidenceRetirementRows,retireEvidence,type EvidenceIdentity,type EvidenceInputs} from '../src/test-evidence.js';

async function main(){
  const [command,name,...paths]=process.argv.slice(2);
  const identity:EvidenceIdentity={run:process.env.GITHUB_RUN_ID??'',attempt:process.env.GITHUB_RUN_ATTEMPT??'',
    revision:process.env.GITHUB_SHA??'',job:process.env.GITHUB_JOB??process.env.LAW_EVIDENCE_JOB??''};
  validateEvidenceIdentity(identity);
  const group=process.env.LAW_EVIDENCE_GROUP;
  if(!/^evidence-[a-z0-9-]{1,50}$/.test(group??''))throw new EvidenceError('GROUP_CONFIGURATION');
  if(!['save','restore','finalize','prune','validate-config'].includes(command)||
    !name||!/^[A-Za-z0-9_-]{1,100}$/.test(name))throw new EvidenceError('COMMAND');
  if(command==='restore'&&name.startsWith('matched-benchmark-fixture-')&&name!==`matched-benchmark-fixture-${identity.attempt}`)
    throw new EvidenceError('COMMON_ATTEMPT_REQUIRED_RERUN_COMPLETE_BENCHMARK');
  if(['finalize','validate-config'].includes(command)&&(name!=='completed'||paths.length))throw new EvidenceError('COMMAND');
  const plan=['finalize','validate-config'].includes(command)?evidencePlan(group!,process.env):null;
  const pruneNamespace=command==='prune'&&group==='evidence-manual-tests'?manualEvidenceScope(process.env).namespace:null;
  if(plan)validateEvidencePlan(plan);
  if(command==='validate-config'){console.log(JSON.stringify({status:'PASS',operation:'evidence-configuration',remoteOperations:0}));return;}
  if(command==='save'&&!paths.some(p=>fs.existsSync(p))&&process.env.LAW_EVIDENCE_ALLOW_EMPTY==='1'){
    console.log(JSON.stringify({status:'SKIPPED',reason:'NO_OPTIONAL_INPUT',name}));return;
  }
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'law-evidence-'));
  const zip=path.join(temp,'evidence.zip'),helper=fileURLToPath(new URL('./evidence_bundle.py',import.meta.url));
  let stage='START';
  try{
    let inventory:EvidenceInputs|undefined;
    if(command==='save'){
      stage='PACK';
      inventory=JSON.parse(execFileSync('python3',[helper,'pack',zip,...paths,
        ...process.env.LAW_EVIDENCE_ALLOW_MISSING==='1'?['--allow-missing']:[]],{encoding:'utf8',stdio:['ignore','pipe','pipe']}));
    }
    if(command==='restore'&&(paths.length!==1||!safeCacheDirectory(paths[0])||fs.existsSync(paths[0])))throw new EvidenceError('NEW_DESTINATION_REQUIRED');
    stage='AUTH_AND_OPEN';
    const store=await DriveReleaseStore.open(google.drive({version:'v3',auth:await authorizeDrive()}),group!,['save','finalize'].includes(command));
    if(command==='save'){
      stage='UPLOAD_AND_VERIFY';await saveEvidenceBundle(store,identity,name,fs.readFileSync(zip),inventory);
    }else if(command==='restore'){
      if(paths.length!==1)throw new EvidenceError('NEW_DESTINATION_REQUIRED');
      stage='DOWNLOAD_AND_VERIFY';
      const producerJob=name.startsWith('matched-benchmark-fixture-')?'benchmark_prepare':process.env.LAW_EVIDENCE_SOURCE_JOB??identity.job;
      const saved=await readEvidenceBundle(store,{...identity,job:producerJob},name);
      fs.writeFileSync(zip,saved.bytes,{flag:'wx'});stage='EXTRACT';
      execFileSync('python3',[helper,'unpack',zip,paths[0]],{stdio:['ignore','pipe','pipe']});
    }else if(command==='finalize'){
      stage='FINALIZE';const receipt=await finalizeEvidence(store,identity,plan!);
      console.log(JSON.stringify({operation:'finalize-evidence',status:receipt.status,run:receipt.id,artifacts:receipt.artifacts.length}));
      if(receipt.status!=='PASS')process.exitCode=1;
    }else{
      stage='RETENTION_PLAN';const rows=await evidenceRetirementRows(store);
      const candidates=obsoleteTestEvidence(pruneNamespace?rows.filter(r=>r.retention?.namespace===pruneNamespace):rows);
      if(candidates.includes(`${identity.run}-${identity.attempt}`))throw new EvidenceError('CURRENT_RUN');
      if(candidates.length)
        await store.assertEvidenceRetirementOwnership(candidates.map(id=>`work/evidence/${id}/`));
      const idle=async(run:string)=>{
        if(!/^[-A-Za-z0-9_.]+\/[-A-Za-z0-9_.]+$/.test(process.env.GITHUB_REPOSITORY??'')||!process.env.GH_TOKEN)throw new EvidenceError('ACTIVITY_CHECK_CREDENTIAL_REQUIRED');
        const response=await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/runs/${run}`,{redirect:'error',signal:AbortSignal.timeout(25_000),
          headers:{Authorization:`Bearer ${process.env.GH_TOKEN}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'}});
        if(!response.ok)throw new EvidenceError('ACTIVITY_CHECK_UNAVAILABLE');const actual=await response.json() as any;
        const attempts=rows.filter(r=>r.logicalUpdate===run);
        if(actual.status!=='completed'||actual.conclusion!=='success'||actual.run_attempt!==Math.max(...attempts.map(r=>Number(r.identity.attempt)))||
          attempts.some(r=>r.identity.revision!==actual.head_sha))throw new EvidenceError('ACTIVE_OR_UNRECEIPTED_RUN');
      };
      console.log(JSON.stringify(await retireEvidence(store,rows,candidates,process.env.LAW_EVIDENCE_PRUNE==='1',idle)));
    }
    console.log(JSON.stringify({status:process.exitCode?'FAIL':'PASS',command,namespace:group,run:`${identity.run}-${identity.attempt}`,name}));
  }catch(error){
    console.error(JSON.stringify({status:'FAIL',stage,code:error instanceof EvidenceError?error.code:'TRANSPORT_OR_LOCAL_IO'}));throw error;
  }finally{fs.rmSync(temp,{recursive:true,force:true});}
}
main().catch(error=>{console.error(JSON.stringify({status:'FAIL',operation:'drive-evidence',code:error instanceof EvidenceError?error.code:'AUTH_OR_TRANSPORT'}));process.exitCode=1;});
