import {isDeepStrictEqual} from 'node:util';
import {loadCheckpoint,validateContext,validateManifest} from './release-engine.js';
import {planningPart} from './release-planning.js';
import {verifyBaseResumeEvidence,verifyBaselineCheckpointReceipts} from './base-resume-evidence.js';
import {hash,readJson,safeKey} from './release-store.js';
import type {ReleaseStore} from './release-store.js';

// A failed peer is not the deliberate fault. Do not leave the priming phase
// until the durable EU checkpoint covers the entire frozen baseline scope.
// All operations here are read-only; corruption/transport errors are fatal,
// while an absent or incomplete checkpoint is explicitly NOT_READY.
export async function baseCheckpointReadiness(store:ReleaseStore,revision:string,configSha256:string){
  const readonly:ReleaseStore={read:store.read.bind(store),stat:store.stat.bind(store),list:store.list.bind(store),
    async write(){throw new Error('Checkpoint readiness cannot mutate Drive.');},
    async remove(){throw new Error('Checkpoint readiness cannot remove Drive data.');}};
  if(await readonly.read('active.json')!==null){
    const proof=await verifyBaseResumeEvidence(readonly,revision,configSha256);
    return {status:'READY' as const,phase:'COMMITTED_BASELINE_PROOF',...proof};
  }
  const raw=await readonly.read('work/context.json');
  if(!raw)return {status:'NOT_READY' as const,reason:'NO_PENDING_CONTEXT'};
  const context:unknown=JSON.parse(raw.toString());validateContext(context);
  if(context.mode!=='initialize'||context.codeRevision!==revision||context.configSha256!==configSha256)
    throw new Error('Checkpoint readiness context differs from this initialization.');
  const baseKey=`base/${context.baseId}/release.json`,baseBytes=await readonly.read(baseKey);
  if(baseBytes!==null){
    const base=JSON.parse(baseBytes.toString());validateManifest(base);
    const meta=await readonly.stat(baseKey);
    if(!meta||meta.size!==baseBytes.length||meta.sha256!==hash(baseBytes)||meta.md5!==hash(baseBytes,'md5')||
      base.kind!=='base'||!isDeepStrictEqual(base.context,context))throw new Error('Prepared baseline checkpoint context or bytes differ.');
    const restored=await verifyBaselineCheckpointReceipts(readonly,base);
    if(!(await readonly.read('work/context.json'))?.equals(raw)||await readonly.read('active.json')!==null)
      throw new Error('Initialization changed during prepared baseline inspection.');
    return {status:'READY' as const,phase:'PREPARED_BASELINE_PROOF',baseId:context.baseId,
      baseOperationId:context.runId,baseManifestSha256:hash(baseBytes),restored};
  }
  const planKey=`work/planning/combined-plan-${hash(Buffer.from('NL-EU'))}.json`;
  if(await readonly.read(planKey)===null)return {status:'NOT_READY' as const,reason:'NO_FROZEN_BASELINE_PLAN'};
  const plan=await planningPart<any>(readonly,context,'combined-plan','NL-EU',async()=>{throw new Error('No compatible frozen baseline plan.');});
  const expected:Record<'NL'|'EU',Set<string>>={NL:new Set(),EU:new Set()};
  for(const module of ['NL','EU'] as const){
    const acts=plan.value?.scopes?.[module]?.acts;
    if(!Array.isArray(acts))throw new Error('Invalid frozen baseline scope.');
    const ids=acts.map(a=>module==='NL'?a.bwbId:a.celex);
    if(ids.some(id=>typeof id!=='string'||!id)||new Set(ids).size!==ids.length)throw new Error('Invalid frozen baseline identities.');
    expected[module]=new Set(ids);
  }
  if(expected.NL.size<2||expected.EU.size<63)throw new Error('Frozen baseline does not meet the 2NL/63EU acceptance floor.');
  const counts:Record<string,number>={};
  for(const module of ['NL','EU'] as const){
    const pointer=await readJson(readonly,`work/checkpoint-${module}.json`) as any;
    if(pointer===null)return {status:'NOT_READY' as const,reason:`NO_${module}_CHECKPOINT`};
    if(!isDeepStrictEqual(pointer.context,context)||pointer.phase!=='base')throw new Error('Checkpoint readiness found a different operation or phase.');
    const checkpoint=await loadCheckpoint(readonly,context,module,'base');
    const stateBytes=checkpoint?.files.get(`${module}/state.json`);
    if(!stateBytes)throw new Error('Checkpoint readiness state is missing.');
    const state=JSON.parse(stateBytes.toString()),acts=module==='NL'?state.completedActs:state.acts;
    if(!Array.isArray(acts))throw new Error('Invalid baseline checkpoint acts.');
    const ids=acts.map(a=>module==='NL'?a.bwbId:a.celex);
    if(new Set(ids).size!==ids.length||ids.some(id=>!expected[module].has(id)))throw new Error('Baseline checkpoint identities differ from the frozen scope.');
    const names=new Set<string>();
    for(const act of acts){
      if(!Array.isArray(act.files)||!act.sourceArchive)throw new Error('Missing baseline checkpoint act files.');
      for(const file of [...act.files,act.sourceArchive]){
        if(typeof file?.name!=='string')throw new Error('Invalid baseline checkpoint file.');safeKey(file.name);
        if(file.name.includes('/')||names.has(file.name))throw new Error('Duplicate or unsafe baseline checkpoint file.');names.add(file.name);
        const bytes=checkpoint!.files.get(`${module}/${file.name}`);
        if(!bytes||hash(bytes,'md5')!==file.md5)throw new Error('Baseline checkpoint act file mismatch.');
      }
    }
    counts[module]=ids.length;
  }
  const fault=await readJson(readonly,`checks/faults/${context.runId}-NL.json`) as any;
  if(!fault||fault.schemaVersion!==1||fault.module!=='NL'||fault.phase!=='base'||!Number.isInteger(fault.completedActs)||fault.completedActs<2||fault.completedActs>counts.NL||
    !isDeepStrictEqual(fault.context,context))throw new Error('Missing exact deliberate NL checkpoint interruption.');
  if(!(await readonly.read('work/context.json'))?.equals(raw)||await readonly.read('active.json')!==null)
    throw new Error('Initialization changed during checkpoint readiness inspection.');
  return {status:counts.NL>=2&&counts.EU===expected.EU.size?'READY' as const:'NOT_READY' as const,
    phase:'PENDING_BASELINE_CHECKPOINTS',operationId:context.runId,completed:counts,expected:{NL:expected.NL.size,EU:expected.EU.size}};
}
