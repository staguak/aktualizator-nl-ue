import {isDeepStrictEqual} from 'node:util';
import {encode,hash,type ReleaseStore,type StoredObject} from './release-store.js';
import {obsoleteTestEvidence,validateManualEvidenceRetention,type ManualEvidenceRetention} from './test-evidence-retention.js';

export interface EvidenceIdentity {run:string;attempt:string;revision:string;job:string}
export interface ExpectedEvidence {name:string;job:string;optional?:boolean;allowPartial?:boolean}
export interface EvidenceInputs {profile:'evidence-input-inventory-v1';requested:string[];missing:string[];files:number;partial:boolean}
export interface EvidenceManifest extends EvidenceIdentity {
  profile:'drive-test-evidence-v2';name:string;bytes:number;sha256:string;
  chunks:({key:string}&StoredObject)[];
  inputs?:EvidenceInputs;
}
export class EvidenceError extends Error {constructor(readonly code:string){super(`Evidence: ${code}`);}}
function fail(code:string):never{throw new EvidenceError(code);}
const validName=(s:unknown):s is string=>typeof s==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(s);
const positive=(s:unknown):s is string=>typeof s==='string'&&/^[1-9]\d*$/.test(s);
const digest=(s:unknown):s is string=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
const sameRun=(a:EvidenceIdentity,b:EvidenceIdentity)=>a.run===b.run&&a.attempt===b.attempt&&a.revision===b.revision;
export function validateEvidenceIdentity(v:EvidenceIdentity):void{
  if(!positive(v?.run)||!positive(v.attempt)||!/^[a-f0-9]{40}$/.test(v.revision)||!validName(v.job))fail('IDENTITY');
}
export const evidencePrefix=(v:EvidenceIdentity)=>`work/evidence/${v.run}-${v.attempt}/`;
const receiptKey=(v:EvidenceIdentity)=>`checks/runs/${v.run}-${v.attempt}.json`;
const leasePrefix=(v:EvidenceIdentity)=>`work/leases/${v.run}-${v.attempt}/`;
const sealKey=(v:EvidenceIdentity)=>`work/seals/${v.run}-${v.attempt}.json`;
async function json(store:ReleaseStore,key:string):Promise<any>{
  const meta=await store.stat(key);if(!meta)return null;
  if(!Number.isSafeInteger(meta.size)||meta.size<0||meta.size>4_000_000)fail('CONTROL_LIMIT');
  const raw=await store.read(key);
  if(!raw||raw.length!==meta.size||hash(raw)!==meta.sha256||hash(raw,'md5')!==meta.md5)fail('CONTROL_INTEGRITY');
  try{return JSON.parse(raw.toString());}catch{fail('CONTROL_JSON');}
}
function metadata(v:StoredObject){
  if(!v||typeof v.id!=='string'||!v.id||!Number.isSafeInteger(v.size)||v.size<0||!digest(v.sha256)||!/^[a-f0-9]{32}$/.test(v.md5))fail('METADATA');
}
export function validateEvidenceManifest(v:EvidenceManifest,identity:EvidenceIdentity,name:string):void{
  validateEvidenceIdentity(identity);validateEvidenceIdentity(v);
  if(v.profile!=='drive-test-evidence-v2'||!sameRun(v,identity)||v.job!==identity.job||v.name!==name||!validName(name)||
    !Number.isSafeInteger(v.bytes)||v.bytes<1||v.bytes>1_000_000_000||!digest(v.sha256)||
    !Array.isArray(v.chunks)||!v.chunks.length||v.chunks.length>10)fail('MANIFEST');
  let total=0;
  for(const [i,c]of v.chunks.entries()){
    metadata(c);
    if(c.size<1||c.size>100_000_000||i<v.chunks.length-1&&c.size!==100_000_000||
      c.key!==evidencePrefix(v)+name+`/parts/${i}-${c.sha256}`)fail('CHUNK');
    total+=c.size;
  }
  if(total!==v.bytes)fail('TOTAL_SIZE');
  if(v.inputs){const i=v.inputs;if(i.profile!=='evidence-input-inventory-v1'||!Array.isArray(i.requested)||!i.requested.length||
    !Array.isArray(i.missing)||[...i.requested,...i.missing].some(p=>typeof p!=='string'||p.length>1024||p.includes('\0'))||
    i.missing.some(p=>!i.requested.includes(p))||!Number.isSafeInteger(i.files)||i.files<0||i.files>5000||i.partial!==(i.missing.length>0))fail('INPUT_INVENTORY');}
}
export async function readEvidenceBundle(store:ReleaseStore,identity:EvidenceIdentity,name:string){
  validateEvidenceIdentity(identity);if(!validName(name))fail('NAME');
  const key=evidencePrefix(identity)+name+'/manifest.json',manifest=await json(store,key) as EvidenceManifest;
  if(!manifest)fail('MISSING_MANIFEST');validateEvidenceManifest(manifest,identity,name);
  const buffers:Buffer[]=[];
  for(const c of manifest.chunks){
    const actual=await store.stat(c.key);if(!isDeepStrictEqual(actual,{id:c.id,size:c.size,md5:c.md5,sha256:c.sha256}))fail('CHUNK_METADATA');
    const b=await store.read(c.key);
    if(!b||b.length!==c.size||hash(b)!==c.sha256||hash(b,'md5')!==c.md5)fail('CHUNK_BYTES');buffers.push(b);
  }
  const bytes=Buffer.concat(buffers);if(hash(bytes)!==manifest.sha256||bytes.length!==manifest.bytes)fail('BUNDLE');
  const manifestObject=await store.stat(key);if(!manifestObject||hash(encode(manifest))!==manifestObject.sha256)fail('MANIFEST_CHANGED');
  return {manifest,manifestObject,bytes};
}
export async function saveEvidenceBundle(store:ReleaseStore,identity:EvidenceIdentity,name:string,bytes:Buffer,inputs?:EvidenceInputs){
  validateEvidenceIdentity(identity);if(!validName(name)||!Buffer.isBuffer(bytes)||bytes.length<1||bytes.length>1_000_000_000)fail('BUNDLE_INPUT');
  // Rejections of already sealed runs must not create a lease.
  if(await json(store,receiptKey(identity)))fail('FINALIZED');
  const lease=leasePrefix(identity)+name+'.json',old=await json(store,lease),sealed=await json(store,sealKey(identity));
  const operation={identity,name,sha256:hash(bytes),bytes:bytes.length,...inputs?{inputs}:{}};
  if(old&&!isDeepStrictEqual(old.operation,operation))fail('FOREIGN_OR_CHANGED_UPLOAD');
  if(sealed&&!old)fail('SEALED');
  const key=evidencePrefix(identity)+name+'/manifest.json';
  if(await store.stat(key)){
    const saved=await readEvidenceBundle(store,identity,name);if(!saved.bytes.equals(bytes))fail('IMMUTABLE_BUNDLE');
    if(old)await store.remove(lease);return saved;
  }
  await store.write(lease,encode({profile:'evidence-upload-v2',operation,state:'UPLOADING'}),false);
  if(!old&&await json(store,sealKey(identity))){await store.remove(lease);fail('SEALED');}
  try{
    const chunks:EvidenceManifest['chunks']=[];
    for(let offset=0;offset<bytes.length;offset+=100_000_000){
      const b=bytes.subarray(offset,offset+100_000_000),part=evidencePrefix(identity)+name+`/parts/${chunks.length}-${hash(b)}`;
      const object=await store.write(part,b,true),back=await store.read(part);
      metadata(object);if(!back||hash(back)!==hash(b)||back.length!==b.length||object.sha256!==hash(b)||object.size!==b.length)fail('UPLOAD_READBACK');
      chunks.push({key:part,...object});
    }
    if(await json(store,receiptKey(identity)))fail('FINALIZED');
    const manifest:EvidenceManifest={profile:'drive-test-evidence-v2',...identity,name,bytes:bytes.length,sha256:hash(bytes),chunks,...inputs?{inputs}:{}};
    await store.write(key,encode(manifest),true);
    const saved=await readEvidenceBundle(store,identity,name);await store.remove(lease);return saved;
  }catch(error){
    // Keep a bounded, resumable record. Never store SDK errors or credentials.
    await store.write(lease,encode({profile:'evidence-upload-v2',operation,state:'FAILED'}),false);throw error;
  }
}
export interface FinalizeEvidencePlan {
  expected:ExpectedEvidence[];jobs:Record<string,'success'|'failure'|'cancelled'|'skipped'>;
  requiredJobs:string[];sequence:number;protected:boolean;
  retention?:ManualEvidenceRetention;
}
export function validateEvidencePlan(plan:FinalizeEvidencePlan):void{
  if(plan.retention!==undefined){
    validateManualEvidenceRetention(plan.retention);
    if(!['initialize','update'].includes(plan.retention.operation)&&!plan.protected)fail('PROTECTED_MANUAL_OPERATION');
  }
  if(!plan.expected.length||new Set(plan.expected.map(e=>e.name)).size!==plan.expected.length||
    plan.expected.some(e=>!validName(e.name)||!validName(e.job)||e.optional!==undefined&&typeof e.optional!=='boolean'||e.allowPartial!==undefined&&typeof e.allowPartial!=='boolean')||
    !plan.requiredJobs.length||plan.requiredJobs.some(j=>!validName(j)||!['success','failure','cancelled','skipped'].includes(plan.jobs[j]))||
    !Number.isSafeInteger(plan.sequence)||plan.sequence<1||typeof plan.protected!=='boolean')fail('FINALIZATION_PLAN');
}
export async function readCompletedEvidence(store:ReleaseStore,identity:EvidenceIdentity){
  validateEvidenceIdentity(identity);const r=await json(store,receiptKey(identity));
  if(!r||r.profile!=='disposable-test-evidence-run-v2'||r.status!=='PASS')fail('INCOMPLETE_RUN');
  validateEvidenceIdentity(r.identity);
  if(!sameRun(r.identity,identity)||r.id!==`${identity.run}-${identity.attempt}`||!Array.isArray(r.artifacts)||
    !Array.isArray(r.plan?.requiredJobs)||!r.plan.requiredJobs.length||
    r.plan.requiredJobs.some((j:string)=>r.plan.jobs?.[j]!=='success'))fail('INCOMPLETE_RUN');
  const object=await store.stat(receiptKey(identity));if(!object)fail('MISSING_COMPLETION');return {receipt:r,object};
}
export async function finalizeEvidence(store:ReleaseStore,identity:EvidenceIdentity,plan:FinalizeEvidencePlan){
  validateEvidenceIdentity(identity);
  validateEvidencePlan(plan);
  const canonical={...plan,expected:[...plan.expected].sort((a,b)=>a.name.localeCompare(b.name)),
    requiredJobs:[...plan.requiredJobs].sort(),jobs:Object.fromEntries(Object.entries(plan.jobs).sort(([a],[b])=>a.localeCompare(b)))};
  const status=plan.requiredJobs.every(j=>plan.jobs[j]==='success')?'PASS':'FAIL';
  const seal={profile:'evidence-seal-v2',identity,plan:canonical};
  const previous=await json(store,sealKey(identity));if(previous&&!isDeepStrictEqual(previous,seal))fail('SEAL_CONFLICT');
  await store.write(sealKey(identity),encode(seal),true);
  if(status==='PASS'&&(await store.list(leasePrefix(identity))).length)fail('ACTIVE_UPLOAD');
  const keys=(await store.list(evidencePrefix(identity))).sort();
  const artifacts=[];
  for(const e of canonical.expected){
    const present=keys.includes(evidencePrefix(identity)+e.name+'/manifest.json');
    if(!present){if(status==='PASS'&&!e.optional)fail('MISSING_REQUIRED_ARTIFACT');continue;}
    try{
      const saved=await readEvidenceBundle(store,{...identity,job:e.job},e.name);
      if(saved.manifest.inputs?.partial&&!e.allowPartial)fail('PARTIAL_REQUIRED_INPUTS');
      artifacts.push({name:e.name,job:e.job,manifest:saved.manifestObject});
    }catch(error){if(status==='PASS'||!(error instanceof EvidenceError))throw error;}
  }
  if(keys.some(k=>!canonical.expected.some(e=>k.startsWith(evidencePrefix(identity)+e.name+'/'))))fail('UNEXPECTED_ARTIFACT');
  const objects=[];
  for(const key of keys){const meta=await store.stat(key);if(!meta)fail('DISAPPEARED_OBJECT');metadata(meta);objects.push({key,...meta});}
  if(status==='PASS'&&(await store.list(leasePrefix(identity))).length)fail('ACTIVE_UPLOAD');
  const receipt={profile:'disposable-test-evidence-run-v2',id:`${identity.run}-${identity.attempt}`,
    logicalUpdate:identity.run,sequence:plan.sequence,status,protected:status!=='PASS'||plan.protected,active:false,
    ...plan.retention?{retention:plan.retention}:{},
    identity,plan:canonical,artifacts,objects};
  await store.write(receiptKey(identity),encode(receipt),true);
  const saved=await json(store,receiptKey(identity));if(!isDeepStrictEqual(saved,receipt))fail('RECEIPT_READBACK');
  return receipt;
}

export async function evidenceRetirementRows(store:ReleaseStore){
  const rows:any[]=[];
  for(const key of await store.list('checks/runs/')){
    const r=await json(store,key);
    // Old unclassified/v1 evidence is preserved, never silently made disposable.
    if(r?.profile!=='disposable-test-evidence-run-v2')continue;
    validateEvidenceIdentity(r.identity);
    validateEvidencePlan(r.plan);
    if(!isDeepStrictEqual(r.retention,r.plan.retention)||r.protected!==(r.status!=='PASS'||r.plan.protected))fail('RETIREMENT_SCOPE_CHANGED');
    if(key!==receiptKey(r.identity)||r.id!==`${r.identity.run}-${r.identity.attempt}`||r.logicalUpdate!==r.identity.run||
      !Array.isArray(r.objects)||r.objects.some((o:any)=>typeof o.key!=='string'||!o.key.startsWith(evidencePrefix(r.identity))))fail('RETIREMENT_RECEIPT');
    rows.push(r);
  }
  return rows;
}
export async function retireEvidence(store:ReleaseStore,rows:Awaited<ReturnType<typeof evidenceRetirementRows>>,ids:string[],execute=false,
  assertIdle?:(logicalUpdate:string)=>Promise<void>){
  if(execute&&!assertIdle)fail('EXTERNAL_ACTIVITY_CHECK_REQUIRED');
  if(execute&&ids.length&&!store.removeIfUnchanged)fail('GUARDED_REMOVAL_REQUIRED');
  const eligible=new Set(obsoleteTestEvidence(rows));if(ids.some(id=>!eligible.has(id)))fail('RETAINED_UPDATE');
  const plans=[];
  for(const id of ids){
    const r=rows.find(r=>r.id===id);if(!r||r.status!=='PASS'||r.protected!==false||r.active!==false)fail('PROTECTED');
    const receipts=await evidenceRetirementRows(store);
    if(!isDeepStrictEqual(receipts.find(x=>x.id===id),r))fail('RECEIPT_CHANGED');
    if((await store.list('work/leases/')).some(k=>k.startsWith(`work/leases/${r.logicalUpdate}-`)))fail('ACTIVE_UPLOAD');
    const keys=await store.list(evidencePrefix(r.identity));
    if(keys.some(k=>!r.objects.some((o:any)=>o.key===k)))fail('UNRECEIPTED_OBJECT');
    for(const key of keys){const expected=r.objects.find((o:any)=>o.key===key),actual=await store.stat(key);
      if(!isDeepStrictEqual(actual,{id:expected.id,size:expected.size,sha256:expected.sha256,md5:expected.md5}))fail('RETIREMENT_OBJECT_CHANGED');}
    plans.push({r,keys});
  }
  if(execute)for(const {r,keys}of plans){
    await assertIdle!(r.logicalUpdate);
    if(!obsoleteTestEvidence(await evidenceRetirementRows(store)).includes(r.id))fail('RETAINED_UPDATE');
    if((await store.list('work/leases/')).some(k=>k.startsWith(`work/leases/${r.logicalUpdate}-`)))fail('ACTIVE_UPLOAD');
    if(!isDeepStrictEqual(await json(store,receiptKey(r.identity)),r))fail('RECEIPT_CHANGED');
    for(const key of keys){
      const expected=r.objects.find((o:any)=>o.key===key),actual=await store.stat(key);
      if(!isDeepStrictEqual(actual,{id:expected.id,size:expected.size,sha256:expected.sha256,md5:expected.md5}))fail('RETIREMENT_OBJECT_CHANGED');
      await store.removeIfUnchanged!(key,{id:expected.id,size:expected.size,sha256:expected.sha256,md5:expected.md5});
    }
    await store.removeEmptyDirectory?.(evidencePrefix(r.identity));
  }
  return {candidates:ids,mode:execute?'trash':'plan',quotaReclaimed:'NOT_MEASURED'};
}
