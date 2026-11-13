import {isDeepStrictEqual} from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import {safeCacheDirectory} from './cache-directory.js';
import {loadCheckpoint,saveCheckpoint,validateContext} from './release-engine.js';
import type {RunContext} from './release-engine.js';
import {encode,hash,safeKey} from './release-store.js';
import type {ReleaseStore} from './release-store.js';

export type PublicationInputs=Map<'NL'|'EU',Map<string,Buffer>>;
const PROFILE='completed-paired-build-v1',MARKER='build-profile.json';
const MAX_FILES=10000,MAX_BYTES=1_000_000_000;
// Preserve the normal output/artifact contract after builders were skipped.
// Publication still uses the verified in-memory buffers, never a second read
// of these mutable diagnostic paths.
export function materializeCompletedOutputs(root:string,inputs:PublicationInputs){
  if(inputs.size!==2||!inputs.has('NL')||!inputs.has('EU'))throw new Error('Completed output requires both jurisdictions.');
  const targets=(['NL','EU'] as const).map(module=>({module,dir:path.join(root,module==='NL'?'output':'output-ue')}));
  for(const {module,dir} of targets){
    if(!safeCacheDirectory(dir))throw new Error('Unsafe completed output directory.');
    if(!['manifest.json','INDEX.md','REPORT.md'].every(name=>inputs.get(module)!.has(name)))throw new Error('Completed output controls are missing.');
    for(const [name,bytes] of inputs.get(module)!){safeKey(name);if(name.includes('/')||!Buffer.isBuffer(bytes))throw new Error('Unsafe completed output file.');}
  }
  for(const {module,dir} of targets){
    fs.rmSync(dir,{recursive:true,force:true});fs.mkdirSync(dir,{recursive:true});
    if(!safeCacheDirectory(dir))throw new Error('Unsafe completed output directory.');
    for(const [name,bytes] of inputs.get(module)!)fs.writeFileSync(path.join(dir,name),bytes,{flag:'wx'});
  }
}
function pack(inputs:PublicationInputs,context:RunContext,phase:'base'|'release'){
  if(inputs.size!==2||!inputs.has('NL')||!inputs.has('EU'))throw new Error('Completed build requires both jurisdictions.');
  const files=new Map<string,Buffer>();let bytes=0;
  for(const module of ['NL','EU'] as const){
    const data=inputs.get(module)!;
    if(!['manifest.json','INDEX.md','REPORT.md'].every(name=>data.has(name)))throw new Error('Completed build controls are missing.');
    for(const [name,value] of [...data].sort(([a],[b])=>a.localeCompare(b))){
      safeKey(name);if(name.includes('/')||!Buffer.isBuffer(value))throw new Error('Invalid completed build file.');
      files.set(`${module}/${name}`,value);bytes+=value.length;
    }
  }
  if(files.size>MAX_FILES||bytes>MAX_BYTES)throw new Error('Completed build snapshot limit exceeded.');
  files.set(MARKER,encode({schemaVersion:1,profile:PROFILE,context,phase,files:files.size,
    validation:'VALIDATED_BEFORE_FREEZE',scope:'Technical immutable input snapshot; original build report is preserved, later process metrics are separate.'}));
  return files;
}
function unpack(files:Map<string,Buffer>,context:RunContext,phase:'base'|'release'):PublicationInputs{
  const marker=files.get(MARKER);if(!marker)throw new Error('Completed build profile is missing.');
  const profile=JSON.parse(marker.toString());
  if(profile.schemaVersion!==1||profile.profile!==PROFILE||profile.phase!==phase||profile.validation!=='VALIDATED_BEFORE_FREEZE'||
    !isDeepStrictEqual(profile.context,context)||profile.files!==files.size-1)throw new Error('Invalid completed build profile.');
  const result:PublicationInputs=new Map([['NL',new Map()],['EU',new Map()]]);
  for(const [key,bytes] of files){
    if(key===MARKER)continue;const match=/^(NL|EU)\/([A-Za-z0-9_.-]+)$/.exec(key);
    if(!match)throw new Error('Invalid completed build snapshot path.');
    result.get(match[1] as 'NL'|'EU')!.set(match[2],bytes);
  }
  pack(result,context,phase);return result;
}

// The callback must return the complete already validated pair. Freeze it
// before any immutable generation write. Retries use those exact original
// bytes (including REPORT), then revalidate them, without rerunning builders.
export async function completedBuild(store:ReleaseStore,context:RunContext,phase:'base'|'release',
  build:()=>Promise<PublicationInputs>,validateRestored:(inputs:PublicationInputs)=>void|Promise<void>,
  completeUnchanged?:(inputs:PublicationInputs)=>Promise<boolean>):Promise<PublicationInputs>{
  validateContext(context);
  const meta=await store.stat('work/checkpoint.json');
  if(meta&&(!Number.isSafeInteger(meta.size)||meta.size<0||meta.size>8_000_000))throw new Error('Completed build pointer limit exceeded.');
  const raw=await store.read('work/checkpoint.json');
  if(raw?(meta===null||raw.length!==meta.size||hash(raw)!==meta.sha256||hash(raw,'md5')!==meta.md5):meta!==null)
    throw new Error('Completed build pointer checksum mismatch.');
  const pointer=raw?JSON.parse(raw.toString()):null;
  if(pointer!==null){
    if(pointer.schemaVersion!==1||!['base','release'].includes(pointer.phase)||!Array.isArray(pointer.objects))
      throw new Error('Invalid completed build checkpoint header.');
    validateContext(pointer.context);
    if(!isDeepStrictEqual(pointer.context,context)&&
      (pointer.context.runId===context.runId||pointer.context.releaseId===context.releaseId))
      throw new Error('Completed build operation context changed.');
    if(isDeepStrictEqual(pointer.context,context)&&pointer.phase===phase){
      if(!Array.isArray(pointer.objects)||pointer.objects.length>MAX_FILES+1||
        pointer.objects.some((o:any)=>!o||!Number.isSafeInteger(o.size)||o.size<0)||
        pointer.objects.reduce((n:number,o:any)=>n+o.size,0)>MAX_BYTES+2_000_000)
        throw new Error('Completed build checkpoint limit exceeded.');
      const saved=await loadCheckpoint(store,context,undefined,phase);
      if(!saved)throw new Error('Completed build checkpoint disappeared.');
      const inputs=unpack(saved.files,context,phase);await validateRestored(inputs);
      if(!(await store.read('work/checkpoint.json'))?.equals(raw!))throw new Error('Completed build checkpoint changed during restore.');
      console.log(`Restored exact completed ${phase} build from verified durable snapshot; builders skipped.`);return inputs;
    }
  }
  const prefix=phase==='base'?`base/${context.baseId}/`:`releases/${context.releaseId}/`;
  if((await store.list(prefix)).length)throw new Error('Partial generation has no matching completed build snapshot; refusing to regenerate immutable inputs.');
  const inputs=await build(),packed=pack(inputs,context,phase);
  // A verified NO_CHANGE is its own durable source-check transaction. It needs
  // no immutable generation snapshot: the previous active generation survives.
  // Failure of that transaction propagates; never fall through to publication.
  if(phase==='release'&&context.mode==='update'&&completeUnchanged&&await completeUnchanged(inputs))return inputs;
  await saveCheckpoint(store,context,phase,packed);return inputs;
}
