import {preflight,validateManifest,validateContext} from './release-engine.js';
import type {ReleaseManifest} from './release-engine.js';
import type {ReleaseStore} from './release-store.js';
import {hash,readJson} from './release-store.js';
import {isDeepStrictEqual} from 'node:util';

// A later ordinary update has a different operationId but the SAME immutable
// base. Always anchor baseline checkpoint evidence to that base's producer,
// rather than silently rejecting genuine receipts for a newer active release.
export async function verifyBaseResumeEvidence(store:ReleaseStore,revision:string,configSha256:string){
  const active=await preflight(store,'update',false);if(!active)throw new Error('Active pair required for baseline resume evidence.');
  const key=`base/${active.baseId}/release.json`,raw=await store.read(key);
  if(!raw||hash(raw)!==active.baseManifestSha256)throw new Error('Base resume manifest anchor mismatch.');
  const base=JSON.parse(raw.toString());validateManifest(base);
  if(base.kind!=='base'||base.context.baseId!==active.baseId||base.context.codeRevision!==revision||base.context.configSha256!==configSha256)
    throw new Error('Base resume evidence belongs to another baseline context.');
  const restored=await verifyBaselineCheckpointReceipts(store,base);
  const after=await store.read('active.json');
  if(!after||JSON.stringify(JSON.parse(after.toString()))!==JSON.stringify(active))throw new Error('Active changed during base resume inspection.');
  return {baseId:active.baseId,baseOperationId:base.context.runId,baseManifestSha256:active.baseManifestSha256,restored};
}

// Shared read-only proof for a prepared base before first active commit and
// the same immutable base after publication. Release-phase work must not make
// genuine baseline reuse receipts disappear or require rebuilding the base.
export async function verifyBaselineCheckpointReceipts(store:ReleaseStore,base:ReleaseManifest){
  validateManifest(base);if(base.kind!=='base')throw new Error('Baseline checkpoint proof requires an immutable base.');
  const {codeRevision:revision,configSha256}=base.context;
  const expected:Record<'NL'|'EU',Set<string>>={NL:new Set(),EU:new Set()};
  for(const module of ['NL','EU'] as const){
    const file=base.files.find(f=>f.jurisdiction===module&&f.name==='manifest.json');if(!file)throw new Error('Base resume module manifest missing.');
    const bytes=await store.read(file.key);if(!bytes||hash(bytes)!==file.sha256)throw new Error('Base resume module anchor mismatch.');
    const manifest=JSON.parse(bytes.toString());
    if(manifest.jurisdiction!==module||manifest.rangeFrom!==base.context.rangeFrom||manifest.rangeTo!==base.context.rangeFrom||!Array.isArray(manifest.acts))throw new Error('Invalid base resume module.');
    const ids=manifest.acts.map((a:any)=>module==='NL'?a.bwbId:a.celex);
    if(ids.some((id:unknown)=>typeof id!=='string'||!id)||new Set(ids).size!==ids.length)throw new Error('Invalid base resume act identities.');
    expected[module]=new Set(ids);
  }
  // These are the authorized corpus acceptance floors, not counters printed
  // by a build. A changed actual baseline scope needs an explicit new review.
  if(expected.NL.size<2||expected.EU.size<63)throw new Error('Base scope does not meet the 2NL/63EU acceptance floor.');
  const found=new Map<string,number>();
  for(const receiptKey of await store.list('checks/resumes/')){
    if(receiptKey.endsWith('/.ready.json'))continue;
    const event=await readJson(store,receiptKey) as any;validateContext(event.context);
    if(event.schemaVersion!==1||event.phase!=='base'||!['NL','EU'].includes(event.module)||
      event.context.runId!==base.context.runId||event.context.releaseId!==base.context.releaseId||
      event.context.codeRevision!==revision||event.context.configSha256!==configSha256)continue;
    if(!isDeepStrictEqual(event.context,base.context))throw new Error('Baseline resume receipt context mismatch.');
    const module=event.module as 'NL'|'EU',ids=event.completedActIds;
    if(!Array.isArray(ids)||new Set(ids).size!==ids.length||ids.some((id:string)=>!expected[module].has(id)))throw new Error('Invalid baseline resume receipt.');
    if(module==='NL'&&ids.length>=2||module==='EU'&&ids.length===expected.EU.size)found.set(module,ids.length);
  }
  if(found.size!==2)throw new Error('Actual NL and complete EU baseline checkpoint reuse has not been proven.');
  return Object.fromEntries(found);
}
