import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {assertSettledPointerOperations,completePointerOperation} from './pointer-work.js';
import {InvalidCheckpoint,loadCheckpoint,validatePointer,commitGeneration,preflight,retainReleaseSweep,validateContext,validateManifest} from './release-engine.js';
import {publicationReport,verifyPublicationReport} from './publication-report.js';
import type {ActivePointer,RunContext} from './release-engine.js';
import {readJson,writeJson} from './release-store.js';
import type {ReleaseStore} from './release-store.js';
import {inErrorPhase} from './operation-errors.js';

// Keep the publication journal until retention, the run receipt and work cleanup
// succeed. A crash in any of these steps must remain resumable without a build.
export async function finalizePublishedRun(store:ReleaseStore,context:RunContext):Promise<ActivePointer>{
  validateContext(context);
  const active=await preflight(store,'update',false);
  if(!active||active.releaseId!==context.releaseId||active.operationId!==context.runId||active.baseId!==context.baseId)
    throw new Error('Finalization requires the committed run to remain active.');
  await assertSettledPointerOperations(store);
  await assertFinalizationWork(store,context,active);
  const receiptKey=`checks/runs/${context.runId}.json`;
  const receipt=await readJson(store,receiptKey);
  if(receipt!==null)validateCompletionReceipt(receipt,context,false);
  if(receipt===null){
    const sweep=await inErrorPhase('RETENTION',()=>retainReleaseSweep(store));
    const report=await publicationReport(store,context,active,sweep.evidence);
    await writeJson(store,receiptKey,{schemaVersion:1,status:'PASS',releaseId:context.releaseId,
      observedOn:context.observedOn,rangeTo:context.rangeTo,completedAt:new Date().toISOString(),report},true);
  }
  else if((receipt as any).report===undefined){
    // Legacy receipts lack an anchored modern sweep: preserve their bytes and
    // perform the original safety checks without claiming retroactive proof.
    await inErrorPhase('RETENTION',()=>retainReleaseSweep(store));
  }
  const saved=await readJson(store,receiptKey) as any;
  validateCompletionReceipt(saved,context,receipt===null);
  if(saved?.report!==undefined)await verifyPublicationReport(store,saved.report,context,active);
  await assertFinalizationWork(store,context,active);
  for(const key of await store.list('work/'))if(key!=='work/publication.json')await store.remove(key);
  await store.remove('work/publication.json');
  await store.removeEmptyDirectory?.('work/');
  return active;
}

export function validateCompletionReceipt(saved:any,context:RunContext,requireReport:boolean){
  if(!saved||typeof saved!=='object'||Array.isArray(saved)||
    !isDeepStrictEqual({...saved,completedAt:undefined,report:undefined},{schemaVersion:1,status:'PASS',releaseId:context.releaseId,
      observedOn:context.observedOn,rangeTo:context.rangeTo,completedAt:undefined,report:undefined})||
    typeof saved.completedAt!=='string'||!Number.isFinite(Date.parse(saved.completedAt))||
    new Date(saved.completedAt).toISOString()!==saved.completedAt||requireReport&&saved.report===undefined)
    throw new Error('Conflicting or missing run completion receipt.');
}
async function assertFinalizationWork(store:ReleaseStore,context:RunContext,active:ActivePointer){
  const work=await readJson(store,'work/context.json');
  if(work!==null){validateContext(work);if(!isDeepStrictEqual(work,context))throw new Error('Finalization refuses a later work context.');}
  const journal=await readJson(store,'work/publication.json') as any;
  if(journal!==null){
    validateContext(journal.context);
    if(!isDeepStrictEqual(journal.context,context)||journal.manifestKey!==active.manifestKey||journal.manifestSha256!==active.manifestSha256)
      throw new Error('Finalization refuses a different publication work context.');
  }
}

export async function reconcilePendingPublication(store:ReleaseStore):Promise<ActivePointer|null>{
  await assertSettledPointerOperations(store);
  const value=await readJson(store,'work/publication.json');
  if(value===null)return null;
  const active=await readJson(store,'active.json');
  if(active!==null){
    validatePointer(active);
    for(const key of ['work/recovery.json','work/rollback.json']){
      const explicit=await readJson(store,key) as any;
      if(explicit?.state==='committed'&&explicit.publicationRetired!==true&&explicit.pointer?.operationId===active.operationId){
        await preflight(store,'update',true);
        await completePointerOperation(store,key,explicit,active);
        return null;
      }
    }
  }
  if(!value||typeof value!=='object'||Array.isArray(value)||!('state' in value))throw new Error('Invalid publication journal.');
  if(!['committing','committed'].includes(String(value.state)))throw new Error('Unsupported pending publication state.');
  if(!('schemaVersion' in value)||value.schemaVersion!==1||!('context' in value)||!('manifestKey' in value)||
    !('manifestSha256' in value)||typeof value.manifestSha256!=='string')throw new Error('Invalid pending publication journal.');
  validateContext(value.context);
  if(value.manifestKey!==`releases/${value.context.releaseId}/release.json`)throw new Error('Pending publication identity mismatch.');
  const manifest=await readJson(store,value.manifestKey);validateManifest(manifest);
  if(!isDeepStrictEqual(value.context,manifest.context))throw new Error('Pending publication context differs from manifest.');
  await commitGeneration(store,{manifest,key:value.manifestKey,sha256:value.manifestSha256});
  return finalizePublishedRun(store,manifest.context);
}

export async function loadProcessingCheckpoint(store:ReleaseStore,context:RunContext,module:'NL'|'EU',phase:'base'|'release'){
  try{return await loadCheckpoint(store,context,module,phase);}
  catch(error){
    if(!(error instanceof InvalidCheckpoint))throw error;
    // A broken work snapshot never authorizes repair or bypass of active data.
    await preflight(store,context.mode,false);
    await writeJson(store,`checks/runs/${context.runId}-${module}-discarded-${randomUUID()}.json`,
      {schemaVersion:1,status:'CHECKPOINT_REJECTED',module,phase,releaseId:context.releaseId,completedAt:new Date().toISOString()},true);
    await store.remove(`work/checkpoint-${module}.json`);
    console.warn(`${module} corrupt processing checkpoint rejected after active preflight; rebuilding from official sources.`);
    return null;
  }
}
export function requestedDatesDiffer(context:RunContext,env:NodeJS.ProcessEnv):boolean{
  return ([['LAW_RANGE_FROM','rangeFrom'],['LAW_RANGE_TO','rangeTo'],['LAW_OBSERVED_ON','observedOn']] as const)
    .some(([key,field])=>env[key]!==undefined&&env[key]!==context[field]);
}
export function requestedRunDiffers(context:RunContext,env:NodeJS.ProcessEnv,configSha256:string):boolean{
  return requestedDatesDiffer(context,env)||context.configSha256!==configSha256||
    env.LAW_SOURCE_AUDIT!==undefined&&env.LAW_SOURCE_AUDIT!==(context.sourceAudit??'conditional')||
    env.LAW_UPDATER_REVISION!==undefined&&env.LAW_UPDATER_REVISION!==context.codeRevision;
}
