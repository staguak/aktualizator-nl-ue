import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {google} from 'googleapis';
import {authorizeDrive} from './drive-auth.js';
import {DriveReleaseStore} from './drive-release-store.js';
import {saveCheckpoint,validateContext} from './release-engine.js';
import {writeJson} from './release-store.js';
import {CheckpointFileReader} from './checkpoint-files.js';
import type {RunContext} from './release-engine.js';
import {interruptVerifiedCheckpoint} from './checkpoint-interruption.js';

let storePromise:Promise<DriveReleaseStore>|undefined;
let queue:Promise<void>=Promise.resolve();
let fileReader:CheckpointFileReader|undefined,readerContext='';
async function checkpointStore(namespace:string):Promise<DriveReleaseStore>{
  if(!storePromise)storePromise=authorizeDrive().then(auth=>DriveReleaseStore.open(google.drive({version:'v3',auth}),namespace,false));
  return storePromise;
}
export async function recordCheckpointResume(module:'NL'|'EU',completedActIds:string[],effectiveCheckpointKey:string):Promise<void>{
  if(!process.env.LAW_RELEASE_CONTEXT||!completedActIds.length)return;
  const context:unknown=JSON.parse(process.env.LAW_RELEASE_CONTEXT);validateContext(context);
  const namespace=process.env.LAW_RELEASE_NAMESPACE;
  if(!namespace||new Set(completedActIds).size!==completedActIds.length||completedActIds.some(id=>typeof id!=='string'||!id))
    throw new Error('Invalid checkpoint reuse receipt.');
  const store=await checkpointStore(namespace),phase=process.env.LAW_RELEASE_PHASE==='base'?'base':'release';
  await writeJson(store,`checks/resumes/${randomUUID()}.json`,{schemaVersion:1,context,module,phase,completedActIds,
    effectiveCheckpointKey,at:new Date().toISOString()},true);
  await interruptVerifiedCheckpoint(store,context,module,phase,completedActIds.length);
}
export async function persistCompletedAct(root:string,module:'NL'|'EU'):Promise<void>{
  // Pure verification builds retain local checkpoints and never acquire Drive credentials.
  if(!process.env.LAW_RELEASE_CONTEXT)return;
  const context:unknown=JSON.parse(process.env.LAW_RELEASE_CONTEXT);validateContext(context);
  const namespace=process.env.LAW_RELEASE_NAMESPACE;
  if(!namespace)throw new Error('Missing durable checkpoint namespace.');
  const phase=process.env.LAW_RELEASE_PHASE==='base'?'base':'release';
  queue=queue.then(async()=>{
    const store=await checkpointStore(namespace);
    const identity=JSON.stringify([root,module,phase,context]);
    if(readerContext!==identity){fileReader=new CheckpointFileReader();readerContext=identity;}
    const dir=path.join(root,module==='NL'?'.checkpoint':'.checkpoint-ue');
    const state=JSON.parse(fs.readFileSync(path.join(dir,'state.json'),'utf8'));
    const files=new Map<string,Buffer>();
    files.set(`${module}/state.json`,Buffer.from(JSON.stringify(state,null,2)+'\n'));
    const acts=module==='NL'?state.completedActs:state.acts;
    if(!Array.isArray(acts))throw new Error('Invalid completed-act checkpoint.');
    for(const act of acts){
      for(const file of [...act.files,act.sourceArchive]){
        if(!file||typeof file.name!=='string'||!/^[A-Za-z0-9_.-]+$/.test(file.name))throw new Error('Invalid checkpoint file.');
        files.set(`${module}/${file.name}`,fileReader!.load(path.join(dir,module==='NL'?'output':'',file.name),file.md5));
      }
    }
    await saveCheckpoint(store,context as RunContext,phase,files,module);
    console.log(`${module} durable completed-act checkpoint verified.`);
    await interruptVerifiedCheckpoint(store,context as RunContext,module,phase,acts.length);
  });
  return queue;
}
