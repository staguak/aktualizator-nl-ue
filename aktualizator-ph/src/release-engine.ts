import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {isCalendarDate} from './calendar.js';
import {assertSettledPointerOperations,completePointerOperation} from './pointer-work.js';
import {runPool} from './concurrency.js';
import {preserveRetiredSources} from './source-history.js';
import {encode,hash,readJson,safeKey,writeJson} from './release-store.js';
import type {ReleaseStore,StoredObject} from './release-store.js';

export interface RunContext {
  schemaVersion:1; runId:string; releaseId:string; baseId:string;
  parentReleaseId:string|null; parentOperationId?:string; codeRevision:string; configSha256:string;
  rangeFrom:string; rangeTo:string; observedOn:string; createdAt:string;
  mode:'initialize'|'update';
  sourceAudit?:'conditional'|'unconditional';
}
export interface ReleaseFile extends StoredObject {key:string; name:string; jurisdiction:'NL'|'EU'}
export interface ReleaseManifest {
  schemaVersion:1; context:RunContext; kind:'base'|'release'; files:ReleaseFile[];
  nlManifest:string; euManifest:string;
}
export interface ActivePointer {
  schemaVersion:1; releaseId:string; baseId:string; manifestKey:string;
  manifestSha256:string; baseManifestSha256:string; committedAt:string; operationId:string;
  openFolder?:string;
  publicationSequence?:number;
}
export interface PublicationJournal {
  schemaVersion:1; context:RunContext; state:'preparing'|'verified'|'committing'|'committed';
  manifestKey:string; manifestSha256?:string;
}
export interface Checkpoint {
  schemaVersion:1; context:RunContext; phase:'base'|'release';
  objects:({localPath:string;key:string}&StoredObject)[];
}
const iso=(s:unknown):s is string=>typeof s==='string'&&Number.isFinite(Date.parse(s))&&new Date(s).toISOString()===s;
function object(x:unknown):asserts x is Record<string,unknown> {
  if(!x||typeof x!=='object'||Array.isArray(x))throw new Error('Expected JSON object.');
}
export function validateContext(value:unknown):asserts value is RunContext {
  object(value);
  if(value.schemaVersion!==1||!['initialize','update'].includes(String(value.mode))||
    !['runId','releaseId','baseId'].every(k=>typeof value[k]==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(value[k] as string))||
    value.sourceAudit!==undefined&&!['conditional','unconditional'].includes(String(value.sourceAudit))||
    !(value.parentReleaseId===null||typeof value.parentReleaseId==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(value.parentReleaseId))||
    (value.parentOperationId!==undefined&&(value.mode!=='update'||typeof value.parentOperationId!=='string'||! /^[A-Za-z0-9_-]{1,100}$/.test(value.parentOperationId)))||
    typeof value.codeRevision!=='string'||!value.codeRevision||!/^([a-f0-9]{64})$/.test(String(value.configSha256))||
    !isCalendarDate(value.rangeFrom)||!isCalendarDate(value.rangeTo)||!isCalendarDate(value.observedOn)||
    value.rangeFrom>value.rangeTo||value.rangeTo>value.observedOn||!iso(value.createdAt)||
    (value.mode==='initialize'&&value.parentReleaseId!==null)||(value.mode==='update'&&value.parentReleaseId===null))
    throw new Error('Invalid frozen run context.');
}
export function newContext(input:Omit<RunContext,'schemaVersion'|'runId'|'releaseId'|'createdAt'>):RunContext {
  const context:RunContext={...input,schemaVersion:1,runId:randomUUID(),releaseId:randomUUID(),createdAt:new Date().toISOString()};
  validateContext(context);return context;
}
// Ordinary publication extends/rechecks the existing range. Returning to an
// older view is an explicit rollback, never an accidental date override.
export function assertRangeProgression(next:RunContext,previous:RunContext):void {
  validateContext(next);validateContext(previous);
  if(next.baseId!==previous.baseId||next.rangeFrom!==previous.rangeFrom)
    throw new Error('Start date/base change requires a separately initialized namespace.');
  if(next.rangeTo<previous.rangeTo||next.observedOn<previous.observedOn)
    throw new Error('Ordinary update cannot move the range or observation date backwards; use explicit rollback.');
}
export async function activeContext(store:ReleaseStore,active:ActivePointer):Promise<RunContext>{
  validatePointer(active);
  const bytes=await store.read(active.manifestKey);
  if(!bytes||hash(bytes)!==active.manifestSha256)throw new Error('Active comparison manifest changed.');
  const manifest:unknown=JSON.parse(bytes.toString());validateManifest(manifest);
  if(manifest.kind!=='release'||manifest.context.releaseId!==active.releaseId||manifest.context.baseId!==active.baseId)
    throw new Error('Active comparison identity mismatch.');
  return manifest.context;
}
export function validatePointer(value:unknown):asserts value is ActivePointer {
  object(value);
  if(value.schemaVersion!==1||!['releaseId','baseId','operationId'].every(k=>typeof value[k]==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(value[k] as string))||
    typeof value.manifestKey!=='string'||value.manifestKey!==`releases/${value.releaseId}/release.json`||
    !/^[a-f0-9]{64}$/.test(String(value.manifestSha256))||!/^[a-f0-9]{64}$/.test(String(value.baseManifestSha256))||!iso(value.committedAt)||
    (value.publicationSequence!==undefined&&(!Number.isSafeInteger(value.publicationSequence)||Number(value.publicationSequence)<1))||
    (value.openFolder!==undefined&&(typeof value.openFolder!=='string'||!/^https:\/\/drive\.google\.com\/drive\/folders\/[A-Za-z0-9_-]+$/.test(value.openFolder))))throw new Error('Invalid active pointer.');
}
export function validateManifest(value:unknown):asserts value is ReleaseManifest {
  object(value);validateContext(value.context);
  if(value.schemaVersion!==1||!['base','release'].includes(String(value.kind))||!Array.isArray(value.files)||!value.files.length)
    throw new Error('Invalid generation manifest.');
  const prefix=value.kind==='base'?`base/${value.context.baseId}`:`releases/${value.context.releaseId}`;
  const keys=new Set<string>();
  for(const file of value.files){
    object(file);
    if(!['NL','EU'].includes(String(file.jurisdiction))||typeof file.name!=='string'||!file.name||
      typeof file.key!=='string'||file.key!==`${prefix}/${file.jurisdiction}/${file.name}`||
      !Number.isSafeInteger(file.size)||Number(file.size)<0||typeof file.id!=='string'||!file.id||
      !/^[a-f0-9]{32}$/.test(String(file.md5))||!/^[a-f0-9]{64}$/.test(String(file.sha256)))throw new Error('Invalid generation file.');
    safeKey(file.key);safeKey(file.name);
    if(file.name.includes('/'))throw new Error('Nested corpus file name refused.');
    if(keys.has(file.key))throw new Error('Duplicate generation file.');keys.add(file.key);
  }
  if(value.nlManifest!==`${prefix}/NL/manifest.json`||value.euManifest!==`${prefix}/EU/manifest.json`||
    !keys.has(String(value.nlManifest))||!keys.has(String(value.euManifest)))throw new Error('Missing paired manifests.');
}
export async function verifyGeneration(store:ReleaseStore,manifest:ReleaseManifest,full=false):Promise<void> {
  validateManifest(manifest);
  const expected=new Set(manifest.files.map(f=>f.key));
  for(const jurisdiction of ['NL','EU']){
    const dir=(manifest.kind==='base'?`base/${manifest.context.baseId}`:`releases/${manifest.context.releaseId}`)+`/${jurisdiction}/`;
    const keys=await store.list(dir);
    if(keys.some(k=>!expected.has(k))||keys.length!==manifest.files.filter(f=>f.jurisdiction===jurisdiction).length)
      throw new Error(`Incomplete or unexpected ${jurisdiction} generation files.`);
  }
  const controls=new Map<string,Buffer>();
  // Independent reads may overlap; the pool drains them before commit can proceed.
  await runPool(manifest.files,4,async f=>{
    const actual=await store.stat(f.key);
    if(!actual||actual.id!==f.id||actual.size!==f.size||actual.md5!==f.md5||actual.sha256!==f.sha256)
      throw new Error(`Generation checksum/identity mismatch: ${f.key}`);
    if(full||f.name==='manifest.json'){
      const bytes=await store.read(f.key);
      if(!bytes||hash(bytes)!==f.sha256||hash(bytes,'md5')!==f.md5)throw new Error(`Generation bytes mismatch: ${f.key}`);
      if(f.name==='manifest.json')controls.set(f.key,bytes);
    }
  });
  for(const [key,jurisdiction] of [[manifest.nlManifest,'NL'],[manifest.euManifest,'EU']] as const){
    const source:unknown=JSON.parse(controls.get(key)!.toString('utf8'));object(source);
    const {rangeFrom,rangeTo}=manifest.context;
    if(source.jurisdiction!==jurisdiction||source.rangeFrom!==rangeFrom||
      source.rangeTo!==(manifest.kind==='base'?rangeFrom:rangeTo))throw new Error('Corpus/generation range mismatch.');
  }
}
export async function preflight(store:ReleaseStore,mode:'initialize'|'update',full=false):Promise<ActivePointer|null> {
  const value=await readJson(store,'active.json');
  if(value===null){
    if(mode==='update')throw new Error('No active release. Explicit initialization required.');
    return null;
  }
  validatePointer(value);
  if(mode==='initialize')throw new Error('Active release already exists. Initialization refused.');
  const bytes=await store.read(value.manifestKey);
  if(!bytes||hash(bytes)!==value.manifestSha256)throw new Error('Active generation manifest checksum mismatch.');
  const manifest:unknown=JSON.parse(bytes.toString());validateManifest(manifest);
  if(manifest.kind!=='release'||manifest.context.releaseId!==value.releaseId||manifest.context.baseId!==value.baseId)
    throw new Error('Active generation identity mismatch.');
  await verifyGeneration(store,manifest,full);
  const base=await verifyBase(store,value.baseId,value.baseManifestSha256,full);
  if(base.context.rangeFrom!==manifest.context.rangeFrom)throw new Error('Base/release range start mismatch.');
  return value;
}
async function verifyBase(store:ReleaseStore,baseId:string,expectedHash:string,full:boolean):Promise<ReleaseManifest>{
  const bytes=await store.read(`base/${baseId}/release.json`);
  if(!bytes||hash(bytes)!==expectedHash)throw new Error('Base manifest anchor mismatch.');
  const base:unknown=JSON.parse(bytes.toString());validateManifest(base);
  if(base.kind!=='base'||base.context.baseId!==baseId)throw new Error('Base identity mismatch.');
  await verifyGeneration(store,base,full);return base;
}
export async function prepareGeneration(store:ReleaseStore,context:RunContext,kind:'base'|'release',
  inputs:Map<'NL'|'EU',Map<string,Buffer>>):Promise<{manifest:ReleaseManifest;key:string;sha256:string}> {
  validateContext(context);
  if(kind==='base'&&context.mode!=='initialize')throw new Error('Base can only be initialized.');
  const prefix=kind==='base'?`base/${context.baseId}`:`releases/${context.releaseId}`;
  if(kind==='base'){
    const other=await store.list('base/');
    if(other.some(k=>!k.startsWith(prefix+'/')))throw new Error('A different base already exists.');
  }
  if(kind==='release')await writeJson(store,prefix+'/preparation.json',{schemaVersion:1,context},true);
  const files:ReleaseFile[]=[];
  for(const jurisdiction of ['NL','EU'] as const){
    const input=inputs.get(jurisdiction);
    if(!input||!['manifest.json','INDEX.md','REPORT.md'].every(n=>input.has(n)))throw new Error(`Missing ${jurisdiction} control files.`);
    console.log(`Preparing ${kind} ${jurisdiction}: ${input.size} immutable files.`);
    for(const [name,bytes] of [...input.entries()].sort(([a],[b])=>a.localeCompare(b))){
      safeKey(name);if(name.includes('/'))throw new Error('Nested corpus file name refused.');
      const key=`${prefix}/${jurisdiction}/${name}`;
      const remote=await store.write(key,bytes,true);
      files.push({key,name,jurisdiction,...remote});
    }
    console.log(`Prepared ${kind} ${jurisdiction}: all file writes verified.`);
  }
  const manifest:ReleaseManifest={schemaVersion:1,context,kind,files,nlManifest:`${prefix}/NL/manifest.json`,euManifest:`${prefix}/EU/manifest.json`};
  await verifyGeneration(store,manifest,true);
  const key=prefix+'/release.json',bytes=encode(manifest);
  const remote=await store.write(key,bytes,true);
  if(remote.sha256!==hash(bytes))throw new Error('Generation manifest write failed.');
  return {manifest,key,sha256:remote.sha256};
}
export async function commitGeneration(store:ReleaseStore,prepared:{manifest:ReleaseManifest;key:string;sha256:string}):Promise<ActivePointer> {
  // The supplied object must describe exactly the manifest anchored on Drive.
  // Reject identity/content mismatches before replacing the publication journal.
  validateManifest(prepared.manifest);
  const {context}=prepared.manifest;
  if(prepared.manifest.kind!=='release')throw new Error('Base is not an active release.');
  if(prepared.key!==`releases/${context.releaseId}/release.json`||!/^[a-f0-9]{64}$/.test(prepared.sha256))
    throw new Error('Prepared manifest identity mismatch.');
  const manifestBytes=await store.read(prepared.key);
  if(!manifestBytes||hash(manifestBytes)!==prepared.sha256)throw new Error('Prepared manifest was modified.');
  const persisted:unknown=JSON.parse(manifestBytes.toString());validateManifest(persisted);
  if(!isDeepStrictEqual(persisted,prepared.manifest))throw new Error('Prepared manifest differs from persisted anchor.');
  await assertSettledPointerOperations(store);
  if(await store.read('work/source-check.json'))throw new Error('Pending source check blocks publication.');
  const journal:PublicationJournal={schemaVersion:1,context,state:'committing',manifestKey:prepared.key,manifestSha256:prepared.sha256};
  const pending=await readJson(store,'work/publication.json') as PublicationJournal|null;
  if(pending!==null){
    object(pending);
    validateContext(pending.context);
    if(pending.schemaVersion!==1||!['committing','committed'].includes(pending.state)||
      pending.manifestKey!==`releases/${pending.context.releaseId}/release.json`||
      typeof pending.manifestSha256!=='string'||!/^[a-f0-9]{64}$/.test(pending.manifestSha256))
      throw new Error('Invalid pending publication journal.');
    if(pending.state!=='committed'&&pending.context.runId!==context.runId)throw new Error('Another publication is pending.');
    if(pending.context.runId===context.runId&&(!isDeepStrictEqual(pending.context,context)||
      pending.manifestKey!==prepared.key||pending.manifestSha256!==prepared.sha256))
      throw new Error('Pending publication identity changed.');
  }
  const activeBytes=await store.read('active.json');
  const value:unknown=activeBytes===null?null:JSON.parse(activeBytes.toString('utf8'));
  if(value!==null){
    validatePointer(value);
    if(value.releaseId===context.releaseId&&value.operationId===context.runId){
      await preflight(store,'update',true);
      if(value.manifestSha256!==prepared.sha256)throw new Error('Committed generation hash changed.');
      await finishCommit(store,value,journal);return value;
    }
  }
  if((value as ActivePointer|null)?.releaseId!==context.parentReleaseId&&!(value===null&&context.parentReleaseId===null))
    throw new Error('Active generation changed: commit refused.');
  if(context.parentOperationId!==undefined&&(value as ActivePointer|null)?.operationId!==context.parentOperationId)
    throw new Error('Active predecessor operation changed: commit refused.');
  if(value!==null){
    await preflight(store,'update',false);
    await assertRangeProgression(context,await activeContext(store,value));
  }
  await verifyGeneration(store,prepared.manifest,true);
  const baseBytes=await store.read(`base/${context.baseId}/release.json`);
  if(!baseBytes)throw new Error('Base manifest unavailable.');
  const baseSha256=hash(baseBytes);
  if(value!==null&&baseSha256!==value.baseManifestSha256)throw new Error('Base manifest anchor changed.');
  const base:unknown=JSON.parse(baseBytes.toString());validateManifest(base);
  if(base.kind!=='base'||base.context.baseId!==context.baseId)throw new Error('Unverified base.');
  if(base.context.rangeFrom!==context.rangeFrom)throw new Error('Base/release range start mismatch.');
  await verifyGeneration(store,base,true);
  const pointer:ActivePointer={schemaVersion:1,releaseId:context.releaseId,baseId:context.baseId,
    manifestKey:prepared.key,manifestSha256:prepared.sha256,baseManifestSha256:baseSha256,committedAt:new Date().toISOString(),operationId:context.runId,
    publicationSequence:((value as ActivePointer|null)?.publicationSequence??0)+1};
  if(store.directoryUrl)pointer.openFolder=await store.directoryUrl(`releases/${context.releaseId}/`);
  const before=await store.read('active.json');
  if(!((before===null&&activeBytes===null)||(before&&activeBytes&&before.equals(activeBytes))))
    throw new Error('Active pointer changed during preparation.');
  await writeJson(store,'work/publication.json',journal);
  try{await writeJson(store,'active.json',pointer);}catch(error){
    // A failed response is not proof of a failed write. Reconcile by operation ID.
    if(!await pointerWriteConfirmed(store,pointer))throw error;
  }
  const actual=await readJson(store,'active.json');
  if(JSON.stringify(actual)!==JSON.stringify(pointer))throw new Error('Active pointer verification failed.');
  await finishCommit(store,pointer,journal);return pointer;
}
async function pointerWriteConfirmed(store:ReleaseStore,pointer:ActivePointer):Promise<boolean>{
  // Recovery may deliberately start with malformed JSON. A failed readback
  // must not replace the original write error with a JSON parsing exception.
  try{return (await store.read('active.json'))?.equals(encode(pointer))??false;}
  catch{return false;}
}
async function finishCommit(store:ReleaseStore,pointer:ActivePointer,journal:PublicationJournal):Promise<void>{
  await writeJson(store,`checks/commits/${pointer.operationId}.json`,pointer,true);
  await writeJson(store,'work/publication.json',{...journal,state:'committed'});
}
export function checkpointCompatible(saved:RunContext,current:RunContext):boolean {
  validateContext(saved);validateContext(current);
  return (saved.sourceAudit??'conditional')===(current.sourceAudit??'conditional')&&['parentReleaseId','parentOperationId','baseId','codeRevision','configSha256','rangeFrom','rangeTo','observedOn','mode'].every(
    k=>saved[k as keyof RunContext]===current[k as keyof RunContext]);
}
// An implicit new day may reuse the frozen attempt. Explicit range/observation
// choices must never be silently replaced by a stored work context.
export function resumeRunContext(saved:RunContext,fresh:RunContext,
  overrides:{LAW_RANGE_TO?:string;LAW_OBSERVED_ON?:string;LAW_SOURCE_AUDIT?:string}={}):RunContext {
  validateContext(saved);validateContext(fresh);
  if(saved.rangeFrom!==fresh.rangeFrom||
    overrides.LAW_RANGE_TO!==undefined&&overrides.LAW_RANGE_TO!==saved.rangeTo||
    overrides.LAW_OBSERVED_ON!==undefined&&overrides.LAW_OBSERVED_ON!==saved.observedOn||
    overrides.LAW_SOURCE_AUDIT!==undefined&&overrides.LAW_SOURCE_AUDIT!==(saved.sourceAudit??'conditional'))return fresh;
  const candidate={...fresh,baseId:fresh.mode==='initialize'?saved.baseId:fresh.baseId,
    rangeTo:saved.rangeTo,observedOn:saved.observedOn,sourceAudit:overrides.LAW_SOURCE_AUDIT===undefined?saved.sourceAudit:fresh.sourceAudit};
  return checkpointCompatible(saved,candidate)?saved:fresh;
}
export async function saveCheckpoint(store:ReleaseStore,context:RunContext,phase:'base'|'release',files:Map<string,Buffer>,module?:'NL'|'EU'):Promise<void>{
  validateContext(context);const objects:Checkpoint['objects']=[];
  const unique=new Map<string,Buffer>(),written=new Map<string,StoredObject>(),digests=new Map<string,string>();
  for(const [localPath,bytes] of files){
    safeKey(localPath);
    const digest=hash(bytes);digests.set(localPath,digest);unique.set(digest,bytes);
  }
  await runPool([...unique.entries()],4,async([digest,bytes])=>{
    written.set(digest,await store.write(`work/snapshots/${digest}`,bytes,true));
  });
  for(const [localPath,bytes]of files){
    const digest=digests.get(localPath)!,key=`work/snapshots/${digest}`;
    objects.push({localPath,key,...written.get(digest)!});
  }
  // Publish the snapshot index only after every referenced object is verified.
  await writeJson(store,module?`work/checkpoint-${module}.json`:'work/checkpoint.json',{schemaVersion:1,context,phase,objects} satisfies Checkpoint);
}
export class InvalidCheckpoint extends Error {
  constructor(message:string){super(message);this.name='InvalidCheckpoint';}
}
export async function loadCheckpoint(store:ReleaseStore,current:RunContext,module?:'NL'|'EU',phase?:'base'|'release'):Promise<{phase:'base'|'release';files:Map<string,Buffer>}|null>{
  let checkpoint:unknown;
  try{checkpoint=await readJson(store,module?`work/checkpoint-${module}.json`:'work/checkpoint.json');}
  catch(error){if(error instanceof SyntaxError)throw new InvalidCheckpoint('Malformed processing checkpoint JSON.');throw error;}
  if(checkpoint===null)return null;
  let objects:Checkpoint['objects'],savedPhase:'base'|'release';
  try{
    object(checkpoint);
    if(checkpoint.schemaVersion!==1||!['base','release'].includes(String(checkpoint.phase))||!Array.isArray(checkpoint.objects))
      throw new Error('Invalid processing checkpoint.');
    validateContext(checkpoint.context);
    if(!checkpointCompatible(checkpoint.context,current)||phase!==undefined&&checkpoint.phase!==phase)return null;
    const paths=new Set<string>();
    for(const entry of checkpoint.objects){
      object(entry);
      if(typeof entry.localPath!=='string'||typeof entry.key!=='string'||
        typeof entry.id!=='string'||!entry.id||!Number.isSafeInteger(entry.size)||Number(entry.size)<0||
        typeof entry.sha256!=='string'||!/^[a-f0-9]{64}$/.test(entry.sha256)||
        typeof entry.md5!=='string'||!/^[a-f0-9]{32}$/.test(entry.md5)||
        entry.key!==`work/snapshots/${entry.sha256}`)throw new Error('Invalid checkpoint object identity.');
      safeKey(entry.localPath);safeKey(entry.key);
      if(module&&!entry.localPath.startsWith(module+'/'))throw new Error('Checkpoint module mismatch.');
      if(paths.has(entry.localPath))throw new Error('Duplicate checkpoint path.');paths.add(entry.localPath);
    }
    objects=checkpoint.objects as Checkpoint['objects'];savedPhase=checkpoint.phase as 'base'|'release';
  }catch(error){throw new InvalidCheckpoint(error instanceof Error?error.message:'Invalid checkpoint.');}
  const files=new Map<string,Buffer>();
  await runPool(objects,4,async entry=>{
    const meta=await store.stat(entry.key),bytes=await store.read(entry.key);
    if(!meta||!bytes||meta.id!==entry.id||meta.size!==entry.size||meta.sha256!==entry.sha256||meta.md5!==entry.md5||
      bytes.length!==entry.size||hash(bytes)!==entry.sha256||hash(bytes,'md5')!==entry.md5)
      throw new InvalidCheckpoint('Checkpoint data corruption.');
    files.set(entry.localPath,bytes);
  });
  return {phase:savedPhase,files};
}
export async function assertInitializationBase(store:ReleaseStore,context:RunContext):Promise<void>{
  validateContext(context);if(context.mode!=='initialize')return;
  const prefix=`base/${context.baseId}/`;
  if((await store.list('base/')).some(key=>!key.startsWith(prefix)))
    throw new Error('Existing initialization base conflicts with this frozen context; use the original revision/context or a separate namespace.');
  const base=await readJson(store,prefix+'release.json');
  if(base!==null){
    validateManifest(base);
    if(base.kind!=='base'||!isDeepStrictEqual(base.context,context))throw new Error('Existing base context conflicts with initialization.');
    await verifyGeneration(store,base,false);
  }
}
export async function retainReleases(store:ReleaseStore,now=new Date(),graceMs=72*3600*1000):Promise<string[]>{
  return (await retainReleaseSweep(store,now,graceMs)).deleted;
}
export async function retainReleaseSweep(store:ReleaseStore,now=new Date(),graceMs=72*3600*1000){
  if(!Number.isFinite(now.getTime())||!Number.isSafeInteger(graceMs)||graceMs<0)throw new Error('Invalid retention clock or grace interval.');
  const active=await preflight(store,'update',false);if(!active)throw new Error('No active release.');
  const commits:ActivePointer[]=[];
  for(const key of await store.list('checks/commits/')){
    const value=await readJson(store,key);validatePointer(value);commits.push(value);
  }
  const sorted=commits.sort((a,b)=>(b.publicationSequence??0)-(a.publicationSequence??0)||b.committedAt.localeCompare(a.committedAt)||b.releaseId.localeCompare(a.releaseId));
  const seen=new Set([active.releaseId]);
  const previous=sorted.filter(p=>{if(seen.has(p.releaseId))return false;seen.add(p.releaseId);return true;});
  const protectedIds=new Set([active.releaseId,...previous.slice(0,2).map(p=>p.releaseId)]);
  for(const p of previous.slice(0,2)){
    const bytes=await store.read(p.manifestKey);
    if(!bytes||hash(bytes)!==p.manifestSha256)throw new Error('Retention recovery release manifest corrupted.');
    const m:unknown=JSON.parse(bytes.toString());validateManifest(m);await verifyGeneration(store,m,false);
  }
  const pending=await readJson(store,'work/publication.json');
  if(pending!==null){object(pending);validateContext(pending.context);if(pending.state!=='committed')protectedIds.add(pending.context.releaseId);}
  for(const key of ['work/checkpoint.json','work/checkpoint-NL.json','work/checkpoint-EU.json']){
    const checkpoint=await readJson(store,key);
    if(checkpoint!==null){object(checkpoint);validateContext(checkpoint.context);protectedIds.add(checkpoint.context.releaseId);
      if(checkpoint.context.parentReleaseId)protectedIds.add(checkpoint.context.parentReleaseId);}
  }
  const workContext=await readJson(store,'work/context.json');
  if(workContext!==null){validateContext(workContext);protectedIds.add(workContext.releaseId);
    if(workContext.parentReleaseId)protectedIds.add(workContext.parentReleaseId);}
  for(const key of ['work/rollback.json','work/recovery.json']){
    const journal=await readJson(store,key) as any;
    if(journal&&journal.state!=='committed'){
      validatePointer(journal.pointer);protectedIds.add(journal.pointer.releaseId);
      if(journal.expectedCurrent)protectedIds.add(journal.expectedCurrent);
    }
  }
  if(!commits.some(p=>isDeepStrictEqual(p,active)))throw new Error('Active commit anchor unavailable for retention.');
  const eligible=previous.filter(p=>{
    if(protectedIds.has(p.releaseId))return false;
    const index=sorted.indexOf(p),successor=index>0?sorted[index-1]:undefined;
    if(!successor)return false; // Missing retirement evidence must preserve data.
    const retiredAt=Math.max(Date.parse(p.committedAt),Date.parse(successor.committedAt));
    return now.getTime()-retiredAt>=graceMs;
  }).map(p=>p.releaseId);
  const committedIds=new Set(commits.map(p=>p.releaseId)),orphanAgeMs=7*24*3600*1000;
  // An abandoned upload needs its own frozen marker. Unknown legacy folders
  // are preserved; name or Drive modification time is not sufficient evidence.
  for(const key of await store.list('releases/'))if(/^releases\/[A-Za-z0-9_-]+\/preparation.json$/.test(key)){
    const marker=await readJson(store,key);object(marker);validateContext(marker.context);
    if(marker.schemaVersion!==1||key!==`releases/${marker.context.releaseId}/preparation.json`)throw new Error('Invalid orphan marker.');
    const id=marker.context.releaseId;
    if(!committedIds.has(id)&&!protectedIds.has(id)&&now.getTime()-Date.parse(marker.context.createdAt)>=orphanAgeMs)eligible.push(id);
  }
  const deleted:string[]=[];
  // Preserve and verify every eligible committed source set before removing
  // any generation. Failure in another candidate must not start this sweep.
  for(const id of new Set(eligible)){
    if(!(await store.list(`releases/${id}/`)).length)continue;
    const committed=commits.find(p=>p.releaseId===id);
    if(committed)await preserveRetiredSources(store,committed);
  }
  for(const id of [...new Set(eligible)]){
    const prefix=`releases/${id}/`,keys=await store.list(prefix);
    if(!keys.length)continue;
    for(const key of keys)await store.remove(key);
    await store.removeEmptyDirectory?.(prefix);
    deleted.push(id);
  }
  const after=await preflight(store,'update',false);
  if(!isDeepStrictEqual(after,active))throw new Error('Active operation changed during retention.');
  const key=`checks/retention/${randomUUID()}.json`;
  const record={profile:'release-retention-v1',releaseId:active.releaseId,operationId:active.operationId,
    baseId:active.baseId,baseManifestSha256:active.baseManifestSha256,at:now.toISOString(),deleted,graceMs,orphanAgeMs,
    retainedRecovery:previous.slice(0,2),protectedReleaseIds:[...protectedIds].sort(),
    sourceHistoryPolicy:'Committed native sources preserved and verified before generation removal'};
  const bytes=encode(record);await store.write(key,bytes,true);
  const saved=await store.read(key);if(!saved||!saved.equals(bytes))throw new Error('Retention evidence persistence failed.');
  await pruneCheckHistory(store,now,commits);
  return {deleted,evidence:{key,sha256:hash(bytes)},record};
}

// A completed NO_CHANGE may bound its operational audit log, but must not
// sweep generations or create a backup/retention rotation merely for a check.
export async function retainOperationalHistory(store:ReleaseStore,now=new Date()):Promise<void>{
  if(!Number.isFinite(now.getTime()))throw new Error('Invalid operational history clock.');
  const active=await preflight(store,'update',false);
  const commits:ActivePointer[]=[];
  for(const key of await store.list('checks/commits/')){
    const value=await readJson(store,key);validatePointer(value);commits.push(value);
  }
  if(!commits.some(pointer=>isDeepStrictEqual(pointer,active)))throw new Error('Active commit anchor unavailable for operational history.');
  await pruneCheckHistory(store,now,commits);
}

async function pruneCheckHistory(store:ReleaseStore,now:Date,commits:ActivePointer[]):Promise<void>{
  const keepCommitKeys=new Set<string>();
  // An interrupted finalizer still needs its immutable receipt even if the
  // operation is older than the ordinary history horizon.
  for(const key of ['work/context.json','work/publication.json','work/source-check.json']){
    const work=await readJson(store,key) as any;
    const context=key==='work/context.json'?work:work?.context;
    if(context){validateContext(context);keepCommitKeys.add(`checks/runs/${context.runId}.json`);
      keepCommitKeys.add(`checks/sources/${context.runId}.json`);}
  }
  const latest=new Map<string,ActivePointer>();
  for(const p of commits)if(!latest.has(p.releaseId)||(latest.get(p.releaseId)!.publicationSequence??0)<(p.publicationSequence??0)||latest.get(p.releaseId)!.committedAt<p.committedAt)latest.set(p.releaseId,p);
  for(const p of latest.values())if(await store.stat(p.manifestKey)){
    keepCommitKeys.add(`checks/commits/${p.operationId}.json`);
    const manifest=await readJson(store,p.manifestKey);validateManifest(manifest);
    keepCommitKeys.add(`checks/runs/${manifest.context.runId}.json`);
  }
  for(const key of await store.list('base/'))if(key.endsWith('/release.json')){
    const base=await readJson(store,key);validateManifest(base);
    keepCommitKeys.add(`checks/commits/${base.context.runId}.json`);
  }
  const ageMs=90*24*3600*1000;
  // Completion reports anchor the exact sweep that finished their publication.
  // Keep that evidence for as long as its run receipt remains retained.
  for(const key of await store.list('checks/runs/')){
    const run=await readJson(store,key) as any;
    const ref=run?.report?.retention?.key;
    if(typeof ref==='string'&&/^checks\/retention\/[A-Za-z0-9_-]+\.json$/.test(ref))keepCommitKeys.add(ref);
  }
  for(const category of ['runs','retention','commits','resumes','sources']){
    const entries:{key:string;time:string}[]=[];
    for(const key of await store.list(`checks/${category}/`)){
      if(key.endsWith('/.ready.json'))continue;
      const value=await readJson(store,key) as any;
      const time=category==='commits'?value?.committedAt:['runs','sources'].includes(category)?value?.completedAt:value?.at;
      if(iso(time))entries.push({key,time}); // Preserve unclassified diagnostics.
    }
    entries.sort((a,b)=>b.time.localeCompare(a.time)||b.key.localeCompare(a.key));
    for(const [i,e]of entries.entries())if(!keepCommitKeys.has(e.key)&&(i>=500||now.getTime()-Date.parse(e.time)>ageMs))await store.remove(e.key);
  }
}

export async function rollbackGeneration(store:ReleaseStore,targetId:string,expectedCurrent:string):Promise<ActivePointer>{
  if(!/^[A-Za-z0-9_-]{1,100}$/.test(targetId))throw new Error('Invalid rollback target.');
  const active=await preflight(store,'update',true);if(!active||active.releaseId!==expectedCurrent)throw new Error('Rollback predecessor changed.');
  if(active.releaseId===targetId){
    const journal=await readJson(store,'work/rollback.json') as {pointer?:ActivePointer;[key:string]:unknown}|null;
    if(journal?.pointer?.operationId===active.operationId){
      await completePointerOperation(store,'work/rollback.json',journal,active);return active;
    }
    if(!await store.read('work/publication.json')&&!await store.read('work/context.json'))return active;
  }
  const key=`releases/${targetId}/release.json`,bytes=await store.read(key);
  if(!bytes)throw new Error('Rollback target unavailable.');
  let targetAnchor:ActivePointer|undefined;
  for(const commitKey of await store.list('checks/commits/')){
    const candidate=await readJson(store,commitKey);validatePointer(candidate);
    if(candidate.releaseId===targetId&&(!targetAnchor||(candidate.publicationSequence??0)>(targetAnchor.publicationSequence??0)))targetAnchor=candidate;
  }
  if(!targetAnchor)throw new Error('Rollback target was never committed.');
  if(hash(bytes)!==targetAnchor.manifestSha256||targetAnchor.baseId!==active.baseId||
    targetAnchor.baseManifestSha256!==active.baseManifestSha256)throw new Error('Rollback target anchor changed.');
  const manifest:unknown=JSON.parse(bytes.toString());validateManifest(manifest);
  if(manifest.kind!=='release'||manifest.context.releaseId!==targetId||manifest.context.baseId!==active.baseId)
    throw new Error('Rollback target belongs to another base.');
  await verifyGeneration(store,manifest,true);
  const journalKey='work/rollback.json';
  const old=await readJson(store,journalKey) as {expectedCurrent:string;expectedOperationId?:string;state:string;pointer:ActivePointer}|null;
  let pointer:ActivePointer;
  if(old?.state==='committing'&&old.expectedCurrent===expectedCurrent&&old.expectedOperationId===active.operationId&&old.pointer.releaseId===targetId){
    validatePointer(old.pointer);pointer=old.pointer;
  }
  else{
    pointer={schemaVersion:1,releaseId:targetId,baseId:active.baseId,manifestKey:key,manifestSha256:hash(bytes),baseManifestSha256:active.baseManifestSha256,
      operationId:randomUUID(),committedAt:new Date().toISOString(),publicationSequence:(active.publicationSequence??0)+1};
    if(store.directoryUrl)pointer.openFolder=await store.directoryUrl(`releases/${targetId}/`);
  }
  const journal={schemaVersion:1,expectedCurrent,expectedOperationId:active.operationId,pointer};
  await writeJson(store,journalKey,{...journal,state:'committing',publicationRetired:false});
  const before=await readJson(store,'active.json');validatePointer(before);
  if(!isDeepStrictEqual(before,active))throw new Error('Rollback commit conflict.');
  try{await writeJson(store,'active.json',pointer);}catch(error){
    if(!await pointerWriteConfirmed(store,pointer))throw error;
  }
  if(JSON.stringify(await readJson(store,'active.json'))!==JSON.stringify(pointer))throw new Error('Rollback pointer verification failed.');
  await preflight(store,'update',true);
  await completePointerOperation(store,journalKey,journal,pointer);
  return pointer;
}

// Explicit repair of the POINTER only. Immutable damaged files are never edited.
// The operator must name a previously committed target and the exact failed
// pointer hash (or 'missing'). Ordinary updates never enter this procedure.
export async function recoverGeneration(store:ReleaseStore,targetId:string,expectedHash:string):Promise<ActivePointer>{
  if(!/^[A-Za-z0-9_-]{1,100}$/.test(targetId)||!/^([a-f0-9]{64}|missing)$/.test(expectedHash))
    throw new Error('Recovery requires a target and exact active pointer hash.');
  const current=await store.read('active.json');
  const currentHash=current?hash(current):'missing';
  const saved=await readJson(store,'work/recovery.json') as any;
  if(saved?.schemaVersion===1&&saved.expectedHash===expectedHash&&saved.targetId===targetId&&saved.pointer){
    validatePointer(saved.pointer);
    if(currentHash===hash(encode(saved.pointer))){
      await preflight(store,'update',true);
      await completePointerOperation(store,'work/recovery.json',saved,saved.pointer);
      return saved.pointer;
    }
  }
  if(currentHash!==expectedHash)throw new Error('Recovery refused: active pointer changed.');
  let anchor:ActivePointer|undefined,maxSequence=0;
  for(const key of await store.list('checks/commits/')){
    const entry=await readJson(store,key);validatePointer(entry);
    maxSequence=Math.max(maxSequence,entry.publicationSequence??0);
    if(entry.releaseId===targetId&&(!anchor||entry.committedAt>anchor.committedAt))anchor=entry;
  }
  if(!anchor)throw new Error('Recovery target was never committed.');
  const bytes=await store.read(anchor.manifestKey);
  if(!bytes||hash(bytes)!==anchor.manifestSha256)throw new Error('Recovery target manifest changed.');
  const manifest:unknown=JSON.parse(bytes.toString());validateManifest(manifest);
  if(manifest.kind!=='release'||manifest.context.releaseId!==targetId||manifest.context.baseId!==anchor.baseId)
    throw new Error('Recovery target identity mismatch.');
  await verifyGeneration(store,manifest,true);
  await verifyBase(store,anchor.baseId,anchor.baseManifestSha256,true);
  const pointer:ActivePointer={...anchor,operationId:randomUUID(),committedAt:new Date().toISOString(),publicationSequence:maxSequence+1};
  if(store.directoryUrl)pointer.openFolder=await store.directoryUrl(`releases/${targetId}/`);
  const journal={schemaVersion:1,state:'committing',expectedHash,targetId,pointer,publicationRetired:false};
  await writeJson(store,'work/recovery.json',journal);
  const before=await store.read('active.json');
  if((before?hash(before):'missing')!==expectedHash)throw new Error('Recovery commit conflict.');
  try{await writeJson(store,'active.json',pointer);}catch(error){
    if(!await pointerWriteConfirmed(store,pointer))throw error;
  }
  const actual=await preflight(store,'update',true);
  if(JSON.stringify(actual)!==JSON.stringify(pointer))throw new Error('Recovery pointer verification failed.');
  await completePointerOperation(store,'work/recovery.json',journal,pointer);
  return pointer;
}
