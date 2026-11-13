import fs from 'node:fs';
import path from 'node:path';
import {preflight,activeContext,validateContext,validatePointer,validateManifest} from './release-engine.js';
import type {ActivePointer} from './release-engine.js';
import {verifyPublicationReport} from './publication-report.js';
import {validateCompletionReceipt} from './release-lifecycle.js';
import {encode,hash} from './release-store.js';
import type {ReleaseStore} from './release-store.js';
import {safeCacheDirectory} from './cache-directory.js';

// A readable active pair and actual checkpoint reuse do not by themselves
// prove that retention, its immutable receipt and work cleanup completed.
export async function inspectCompletionEvidence(store:ReleaseStore,checkedActive?:ActivePointer){
  const readonly:ReleaseStore={read:store.read.bind(store),stat:store.stat.bind(store),list:store.list.bind(store),
    async write(){throw new Error('Completion inspection cannot write backend data.');},async remove(){throw new Error('Completion inspection cannot remove backend data.');}};
  // The combined --check just completed its full preflight. Reuse that result,
  // then recheck exact control anchors instead of repeating every file stat.
  const active=checkedActive??await preflight(readonly,'update',false);if(!active)throw new Error('Completion inspection requires an active pair.');validatePointer(active);
  const context=await activeContext(readonly,active),pointer=await readonly.read('active.json');
  if(!pointer||JSON.stringify(JSON.parse(pointer.toString()))!==JSON.stringify(active))throw new Error('Completion active pointer changed.');
  const native=new Map<string,Buffer>([['active.json',pointer]]);
  const observed=new Map<string,Buffer|null>([['active.json',pointer]]);
  const root=await readonly.read(active.manifestKey);if(!root||hash(root)!==active.manifestSha256)throw new Error('Completion generation anchor changed.');
  native.set('generation.json',root);
  observed.set(active.manifestKey,root);
  const base=await readonly.read(`base/${active.baseId}/release.json`);if(!base||hash(base)!==active.baseManifestSha256)throw new Error('Completion base anchor changed.');
  const baseManifest=JSON.parse(base.toString());validateManifest(baseManifest);
  if(baseManifest.kind!=='base'||baseManifest.context.baseId!==active.baseId||baseManifest.context.rangeFrom!==context.rangeFrom)throw new Error('Completion base identity changed.');
  native.set('base-generation.json',base);
  observed.set(`base/${active.baseId}/release.json`,base);
  const receiptKey=`checks/runs/${context.runId}.json`,raw=await readonly.read(receiptKey);
  observed.set(receiptKey,raw);
  let completion:'MISSING'|'LEGACY_UNSTRUCTURED'|'VERIFIED'='MISSING';
  if(raw){
    native.set('completion.json',raw);const receipt=JSON.parse(raw.toString());validateCompletionReceipt(receipt,context,false);
    completion='LEGACY_UNSTRUCTURED';
    if(receipt.report!==undefined){
      await verifyPublicationReport(readonly,receipt.report,context,active);completion='VERIFIED';
      const sweep=await readonly.read(receipt.report.retention.key);
      if(!sweep||hash(sweep)!==receipt.report.retention.sha256)throw new Error('Completion retention anchor changed.');
      native.set('retention.json',sweep);
      observed.set(receipt.report.retention.key,sweep);
    }
  }
  const workKeys=(await readonly.list('work/')).sort();
  let workOperationId:string|null=null,publicationOperationId:string|null=null;
  for(const [key,name] of [['work/context.json','work-context.json'],['work/publication.json','work-publication.json']]){
    const bytes=await readonly.read(key);observed.set(key,bytes);if(!bytes)continue;
    native.set(name,bytes);const value=JSON.parse(bytes.toString()),work=key.endsWith('/context.json')?value:value.context;validateContext(work);
    if(key.endsWith('/context.json'))workOperationId=work.runId;else publicationOperationId=work.runId;
  }
  const laterWork=[workOperationId,publicationOperationId].some(id=>id!==null&&id!==context.runId);
  const status=completion==='VERIFIED'?(workKeys.length?laterWork?'FINALIZED_WITH_LATER_WORK':'PENDING_CLEANUP':'FINALIZED'):
    completion==='MISSING'?'MISSING_COMPLETION':'LEGACY_COMPLETION_UNVERIFIED';
  const after=await readonly.read('active.json');
  if(!after?.equals(pointer)||JSON.stringify(await readonly.list('work/').then(keys=>keys.sort()))!==JSON.stringify(workKeys))throw new Error('Completion state changed during inspection.');
  for(const [key,before] of observed){const now=await readonly.read(key);if(before===null?now!==null:!now?.equals(before))throw new Error('Completion control bytes changed during inspection.');}
  const rootFolder=await store.directoryUrl?.('/')??null;
  const report={profile:'paired-completion-inspection-v1',status,completion,releaseId:active.releaseId,baseId:active.baseId,operationId:context.runId,
    codeRevision:context.codeRevision,configSha256:context.configSha256,activeSha256:hash(pointer),manifestSha256:active.manifestSha256,baseManifestSha256:active.baseManifestSha256,
    receiptKey,work:{files:workKeys.length,operationId:workOperationId,publicationOperationId,laterOperationPresent:laterWork},
    rootFolder,nativeSha256:Object.fromEntries([...native].map(([name,bytes])=>[name,hash(bytes)])),observedAt:new Date().toISOString(),
    scope:'Read-only anchored commit/retention/completion and work-state inspection. Not a new full payload/source run, finalization, repair or production cutover.'};
  return {report,native};
}
export async function assertFinalizedRun(store:ReleaseStore,checkedActive?:ActivePointer){
  const inspected=await inspectCompletionEvidence(store,checkedActive);
  if(inspected.report.status!=='FINALIZED')throw new Error('Active pair has not completed finalization and work cleanup.');
  return inspected.report;
}
export async function exportCompletionEvidence(store:ReleaseStore,directory:string){
  if(!safeCacheDirectory(directory))throw new Error('Unsafe completion evidence directory.');
  const {report,native}=await inspectCompletionEvidence(store);
  fs.mkdirSync(directory,{recursive:true});if(!safeCacheDirectory(directory))throw new Error('Unsafe completion evidence directory.');
  for(const [name,bytes] of [...native,['inspection.json',encode(report)] as [string,Buffer]]){
    const file=path.join(directory,name);
    try{fs.writeFileSync(file,bytes,{flag:'wx'});}
    catch(error){
      if((error as NodeJS.ErrnoException).code!=='EEXIST')throw new Error('Completion evidence persistence failed.');
      if(!fs.lstatSync(file).isFile()||!fs.readFileSync(file).equals(bytes))throw new Error('Conflicting completion evidence.');
    }
  }
  return report;
}
