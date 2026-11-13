import test from 'node:test';
import assert from 'node:assert/strict';
import {baseCheckpointReadiness} from './base-checkpoint-readiness.js';
import {newContext,saveCheckpoint} from './release-engine.js';
import {planningPart} from './release-planning.js';
import {encode,hash} from './release-store.js';
import type {ReleaseStore} from './release-store.js';

class Store implements ReleaseStore {
  files=new Map<string,Buffer>();
  async read(key:string){return this.files.get(key)??null;}
  async stat(key:string){const b=this.files.get(key);return b?{id:key,size:b.length,sha256:hash(b),md5:hash(b,'md5')}:null;}
  async list(prefix:string){return [...this.files.keys()].filter(k=>k.startsWith(prefix));}
  async write(key:string,bytes:Buffer,immutable:boolean){
    if(immutable&&this.files.has(key))assert.deepEqual(this.files.get(key),bytes);
    this.files.set(key,Buffer.from(bytes));return (await this.stat(key))!;
  }
  async remove(key:string){this.files.delete(key);}
}
async function fixture(euCount=47,expectedEu=63){
  const store=new Store(),context=newContext({mode:'initialize',baseId:'technical-base',parentReleaseId:null,
    codeRevision:'a'.repeat(40),configSha256:'b'.repeat(64),rangeFrom:'2025-01-01',rangeTo:'2026-10-20',observedOn:'2026-10-21'});
  const ids=(module:string,n:number)=>Array.from({length:n},(_,i)=>`technical-${module}-${i}`);
  await store.write('work/context.json',encode(context),false);
  const value={scopes:{NL:{acts:ids('NL',23).map(bwbId=>({bwbId}))},EU:{acts:ids('EU',expectedEu).map(celex=>({celex}))}}};
  await planningPart(store,context,'combined-plan','NL-EU',async()=>({value,archives:new Map([['technical.sources.zip',Buffer.from('explicit technical planning evidence')]])}));
  const save=async(module:'NL'|'EU',n:number)=>{
    const files=new Map<string,Buffer>();
    const acts=ids(module,n).map((id,i)=>{
      const name=`technical-${module}-${i}.sources.zip`,bytes=Buffer.from(`explicit technical checkpoint ${id}`);
      files.set(`${module}/${name}`,bytes);
      return {[module==='NL'?'bwbId':'celex']:id,files:[],sourceArchive:{name,md5:hash(bytes,'md5')}};
    });
    files.set(`${module}/state.json`,encode({[module==='NL'?'completedActs':'acts']:acts}));
    await saveCheckpoint(store,context,'base',files,module);
  };
  await save('NL',2);await save('EU',euCount);
  await store.write(`checks/faults/${context.runId}-NL.json`,encode({schemaVersion:1,context,module:'NL',phase:'base',completedActs:2,confirmedAt:new Date().toISOString()}),true);
  return {store,context,save,inspect:()=>baseCheckpointReadiness(store,context.codeRevision,context.configSha256)};
}

test('partial EU peer after a deliberate NL fault cannot advance acceptance; same-operation completed checkpoints can',async t=>{
  t.mock.method(console,'log',()=>{});const f=await fixture(),before=new Map(f.store.files);
  const partial=await f.inspect();assert.equal(partial.status,'NOT_READY');assert.deepEqual(partial.completed,{NL:2,EU:47});
  assert.deepEqual(f.store.files,before,'readiness must never discard or rewrite the partial checkpoint');
  await f.save('EU',63);const complete=await f.inspect();assert.equal(complete.status,'READY');assert.deepEqual(complete.completed,{NL:2,EU:63});
});
test('readiness requires the entire frozen EU scope, never just a hardcoded 63 or a printed count',async t=>{
  t.mock.method(console,'log',()=>{});const f=await fixture(63,65);
  assert.equal((await f.inspect()).status,'NOT_READY');await f.save('EU',65);assert.equal((await f.inspect()).status,'READY');
  const pointer=JSON.parse(f.store.files.get('work/checkpoint-EU.json')!.toString());
  const state=pointer.objects.find((o:any)=>o.localPath==='EU/state.json');
  f.store.files.set(state.key,Buffer.from('corrupt state claiming all acts complete'));
  await assert.rejects(f.inspect(),/corruption/);
});
test('checkpoint readiness rejects different operations, corrupted payloads and missing interruption proof without mutations',async t=>{
  t.mock.method(console,'log',()=>{});
  for(const kind of ['operation','payload','fault'] as const){
    const f=await fixture(63),key='work/checkpoint-EU.json',pointer=JSON.parse(f.store.files.get(key)!.toString());
    if(kind==='operation'){pointer.context.runId='another-technical-operation';f.store.files.set(key,encode(pointer));}
    if(kind==='payload')f.store.files.set(pointer.objects.find((o:any)=>o.localPath!=='EU/state.json').key,Buffer.from('corrupt'));
    if(kind==='fault')f.store.files.delete(`checks/faults/${f.context.runId}-NL.json`);
    const before=new Map(f.store.files);await assert.rejects(f.inspect(),/different operation|corruption|interruption/);assert.deepEqual(f.store.files,before);
  }
});
test('missing pending state is NOT_READY, but invalid context and storage failure are fatal',async t=>{
  t.mock.method(console,'log',()=>{});const empty=new Store();
  assert.equal((await baseCheckpointReadiness(empty,'a'.repeat(40),'b'.repeat(64))).status,'NOT_READY');
  const f=await fixture();await assert.rejects(baseCheckpointReadiness(f.store,'c'.repeat(40),f.context.configSha256),/context differs/);
  f.store.read=async()=>{throw new Error('transient backend failure');};await assert.rejects(f.inspect(),/transient backend failure/);
});
