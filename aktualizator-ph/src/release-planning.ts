import {checkpointCompatible,validateContext} from './release-engine.js';
import type {RunContext} from './release-engine.js';
import {encode,hash,readJson,safeKey,writeJson} from './release-store.js';
import type {ReleaseStore,StoredObject} from './release-store.js';
import {runPool} from './concurrency.js';
import {preserveWrappedFailure} from './operation-errors.js';
import {safeFailureMessage} from './drive-retry.js';
import fs from 'node:fs';
import path from 'node:path';

export interface PlanningPart<T> {value:T;archives:Map<string,Buffer>}
interface Reference extends StoredObject {key:string;name:string}

// Export the exact persisted planning capsules, never a replacement fetch.
// This adapter makes accidental mutation impossible during diagnostics.
export async function exportPlanningDiagnostics(store:ReleaseStore,context:RunContext,directory:string){
  validateContext(context);
  fs.mkdirSync(directory,{recursive:true});
  if(!fs.lstatSync(directory).isDirectory())throw new Error('Planning diagnostics require a regular directory.');
  const write=(name:string,bytes:Buffer)=>{
    const target=path.join(directory,name);
    try{fs.writeFileSync(target,bytes,{flag:'wx'});}
    catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
      if(!fs.lstatSync(target).isFile()||!fs.readFileSync(target).equals(bytes))throw new Error('Conflicting planning diagnostic evidence.');}
  };
  const readonly:ReleaseStore={read:store.read.bind(store),stat:store.stat.bind(store),list:store.list.bind(store),
    async write(){throw new Error('Planning diagnostics cannot write Drive.');},async remove(){throw new Error('Planning diagnostics cannot remove Drive data.');}};
  const records=[];
  for(const key of (await readonly.list('work/planning/')).sort()){
    if(key==='work/planning/.ready'){
      const marker=await readonly.read(key);
      if(!marker?.equals(Buffer.from('verified initial selection tasks\n')))throw new Error('Invalid planning directory marker.');
      continue;
    }
    const pointer=await readJson(readonly,key) as any;
    if(!pointer||typeof pointer.stage!=='string'||typeof pointer.identifier!=='string'||
      key!==`work/planning/${pointer.stage}-${hash(Buffer.from(pointer.identifier))}.json`)throw new Error('Invalid planning diagnostic pointer.');
    validateContext(pointer.context);
    if(!checkpointCompatible(pointer.context,context)||pointer.context.runId!==context.runId||pointer.context.releaseId!==context.releaseId)continue;
    const part=await planningPart(readonly,context,pointer.stage,pointer.identifier,async()=>{throw new Error('Missing persisted planning evidence.');});
    const archives=[...part.archives].sort(([a],[b])=>a.localeCompare(b)).map(([name,bytes])=>{
      const sha256=hash(bytes),file=sha256+'.zip';write(file,bytes);return {name,file,sha256,size:bytes.length};
    });
    const record=encode({schemaVersion:1,status:'PLANNING_DIAGNOSTIC_ONLY',context,stage:pointer.stage,identifier:pointer.identifier,
      value:part.value,archives,scope:'Exact verified Drive planning evidence; not a complete or publishable corpus.'});
    const file=hash(record)+'.planning.json';write(file,record);records.push({stage:pointer.stage,identifier:pointer.identifier,file,sha256:hash(record)});
  }
  if(!records.length)throw new Error('No compatible persisted planning evidence.');
  const report={schemaVersion:1,status:'EXPORTED',context,records};const bytes=encode(report);
  write(hash(bytes)+'.planning-index.json',bytes);return report;
}

async function verifiedRead(store:ReleaseStore,reference:Reference):Promise<Buffer>{
  if(!reference||typeof reference.name!=='string'||!/^[A-Za-z0-9_.-]+$/.test(reference.name)||
    reference.key!==`work/snapshots/${reference.sha256}`)throw new Error('Invalid planning evidence reference.');
  const [bytes,meta]=await Promise.all([store.read(reference.key),store.stat(reference.key)]);
  if(!bytes||!meta||meta.id!==reference.id||bytes.length!==reference.size||meta.size!==reference.size||
    hash(bytes)!==reference.sha256||hash(bytes,'md5')!==reference.md5||
    meta.sha256!==reference.sha256||meta.md5!==reference.md5)throw new Error('Planning evidence corruption.');
  return bytes;
}

// Each completed discovery/selection task survives failure before the first
// complete act. Mutable pointers are published after immutable evidence bytes.
export async function planningPart<T>(store:ReleaseStore,context:RunContext,stage:string,identifier:string,
  build:()=>Promise<PlanningPart<T>>):Promise<PlanningPart<T>>{
  validateContext(context);
  if(!/^[a-z-]+$/.test(stage)||!identifier)throw new Error('Invalid planning task identity.');
  const identity=hash(Buffer.from(identifier)),pointerKey=`work/planning/${stage}-${identity}.json`;
  safeKey(pointerKey);
  const pointer=await readJson(store,pointerKey) as any;
  if(pointer!==null){
    if(pointer.schemaVersion!==1||pointer.stage!==stage||pointer.identifier!==identifier)
      throw new Error(`Invalid planning pointer: ${stage} ${identifier}.`);
    validateContext(pointer.context);
    if(checkpointCompatible(pointer.context,context)&&pointer.context.runId===context.runId&&pointer.context.releaseId===context.releaseId){
      const capsule=JSON.parse((await verifiedRead(store,pointer.capsule)).toString('utf8'));
      validateContext(capsule.context);
      if(capsule.schemaVersion!==1||capsule.stage!==stage||capsule.identifier!==identifier||
        !checkpointCompatible(capsule.context,context)||capsule.context.runId!==context.runId||
        capsule.context.releaseId!==context.releaseId||!Array.isArray(capsule.archives))throw new Error('Invalid planning capsule.');
      const archives=new Map<string,Buffer>();
      const names=new Set<string>();
      for(const reference of capsule.archives){
        if(names.has(reference.name))throw new Error('Duplicate planning evidence archive.');
        names.add(reference.name);
      }
      await runPool<Reference>(capsule.archives,4,async reference=>{
        archives.set(reference.name,await verifiedRead(store,reference));
      });
      if(!archives.size)throw new Error('Missing planning source evidence.');
      console.log(`Base planning restored ${stage} ${identifier}.`);
      return {value:capsule.value as T,archives};
    }
  }
  console.log(`Base planning start ${stage} ${identifier}.`);
  let result:PlanningPart<T>;
  try{result=await build();}
  catch(error){
    const reason=safeFailureMessage(error,'source operation failed');
    throw preserveWrappedFailure(error,new Error(`Base planning ${stage} ${identifier}: ${reason}`));
  }
  if(!result.archives.size)throw new Error(`Missing planning source evidence: ${stage} ${identifier}.`);
  const references:Reference[]=[];
  for(const [name,bytes] of result.archives){
    if(!/^[A-Za-z0-9_.-]+$/.test(name))throw new Error('Unsafe planning source archive name.');
    const key=`work/snapshots/${hash(bytes)}`;
    references.push({name,key,...await store.write(key,bytes,true)});
  }
  const bytes=encode({schemaVersion:1,context,stage,identifier,value:result.value,archives:references});
  const key=`work/snapshots/${hash(bytes)}`;
  const capsule={name:'capsule.json',key,...await store.write(key,bytes,true)};
  await writeJson(store,pointerKey,{schemaVersion:1,context,stage,identifier,capsule});
  console.log(`Base planning verified ${stage} ${identifier}.`);
  return result;
}
