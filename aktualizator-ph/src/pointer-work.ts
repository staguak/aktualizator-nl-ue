import type {ActivePointer} from './release-engine.js';
import {hash,readJson,writeJson} from './release-store.js';
import type {ReleaseStore} from './release-store.js';

export async function assertSettledPointerOperations(store:ReleaseStore):Promise<void>{
  for(const key of ['work/recovery.json','work/rollback.json']){
    const journal=await readJson(store,key);
    if(journal!==null&&(!journal||typeof journal!=='object'||!('state' in journal)||
      journal.state!=='committed'||'publicationRetired' in journal&&journal.publicationRetired===false))
      throw new Error('Unfinished explicit pointer operation blocks ordinary publication.');
  }
}

// Preserve processing snapshots as evidence, but prevent a superseded publication
// and its frozen context from silently running again after an explicit recovery.
export async function completePointerOperation(store:ReleaseStore,key:string,journal:Record<string,unknown>,pointer:ActivePointer):Promise<void>{
  await writeJson(store,`checks/commits/${pointer.operationId}.json`,pointer,true);
  if(journal.state==='committed'&&journal.publicationRetired===true)return;
  await writeJson(store,key,{...journal,state:'committed',publicationRetired:false});
  const receiptKey=`checks/runs/${pointer.operationId}-superseded.json`,existing=await readJson(store,receiptKey);
  if(existing===null){
    const pending=await store.read('work/publication.json');
    await writeJson(store,receiptKey,{schemaVersion:1,status:'SUPERSEDED_PUBLICATION',operationId:pointer.operationId,
      releaseId:pointer.releaseId,publicationSha256:pending?hash(pending):null,completedAt:pointer.committedAt},true);
  }else if(!existing||typeof existing!=='object'||!('operationId' in existing)||existing.operationId!==pointer.operationId||
    !('releaseId' in existing)||existing.releaseId!==pointer.releaseId)throw new Error('Conflicting superseded publication receipt.');
  await store.remove('work/publication.json');
  await store.remove('work/source-check.json');
  await store.remove('work/context.json');
  await writeJson(store,key,{...journal,state:'committed',publicationRetired:true});
}
