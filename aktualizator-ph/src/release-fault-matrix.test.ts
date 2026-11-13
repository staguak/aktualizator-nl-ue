import test from 'node:test';
import assert from 'node:assert/strict';
import {encode,hash} from './release-store.js';
import type {ReleaseStore,StoredObject} from './release-store.js';
import {commitGeneration,loadCheckpoint,newContext,preflight,prepareGeneration,recoverGeneration,
  retainReleases,rollbackGeneration,saveCheckpoint} from './release-engine.js';
import type {RunContext} from './release-engine.js';
import {finalizePublishedRun,reconcilePendingPublication} from './release-lifecycle.js';

// Durable state survives each simulated process death; the fault injector does
// not. These tests exercise engine ordering, not Google's backend guarantees.
class CrashStore implements ReleaseStore {
  objects=new Map<string,{bytes:Buffer;meta:StoredObject}>();
  count=0;mutations=0;accesses=0;cut=Infinity;when:'before'|'after'='before';crashed=false;mode:'mutation'|'access'='mutation';
  clone(){const copy=new CrashStore();copy.count=this.count;
    for(const [key,value] of this.objects)copy.objects.set(key,{bytes:Buffer.from(value.bytes),meta:{...value.meta}});
    return copy;}
  private crash(when:'before'|'after',access=false){
    if((access?'access':'mutation')===this.mode&&(access?this.accesses:this.mutations)===this.cut&&this.when===when){this.crashed=true;this.cut=Infinity;throw new Error('PROCESS_CRASH');}
  }
  async read(key:string){this.accesses++;this.crash('before',true);return this.objects.get(key)?.bytes??null;}
  async stat(key:string){this.accesses++;this.crash('before',true);return this.objects.get(key)?.meta??null;}
  async list(prefix:string){this.accesses++;this.crash('before',true);return [...this.objects.keys()].filter(key=>key.startsWith(prefix)).sort();}
  async write(key:string,bytes:Buffer,immutable:boolean){
    this.mutations++;this.crash('before');const old=this.objects.get(key);
    if(old&&immutable&&!old.bytes.equals(bytes))throw new Error('Immutable overwrite');
    const meta={id:old?.meta.id??String(++this.count),size:bytes.length,md5:hash(bytes,'md5'),sha256:hash(bytes)};
    this.objects.set(key,{bytes:Buffer.from(bytes),meta});this.crash('after');return meta;
  }
  async remove(key:string){this.mutations++;this.crash('before');this.objects.delete(key);this.crash('after');}
}
const context=(parent:string|null=null)=>newContext({baseId:'matrix-base',parentReleaseId:parent,
  mode:parent?'update':'initialize',codeRevision:'matrix-code',configSha256:'a'.repeat(64),
  rangeFrom:'2025-01-01',rangeTo:'2026-10-17',observedOn:'2026-10-17'});
function inputs(c:RunContext,base=false){return new Map((['NL','EU'] as const).map(j=>[j,new Map([
  ['manifest.json',encode({jurisdiction:j,rangeFrom:c.rangeFrom,rangeTo:base?c.rangeFrom:c.rangeTo})],
  ['INDEX.md',Buffer.from('technical matrix index')],['REPORT.md',Buffer.from('technical matrix PASS')],
  ['law.bin',Buffer.from('technical paired fixture '+j)],
])]));}
async function initialized(){const store=new CrashStore(),c=context();
  await prepareGeneration(store,c,'base',inputs(c,true));
  await commitGeneration(store,await prepareGeneration(store,c,'release',inputs(c)));
  await finalizePublishedRun(store,c);return {store,c};}

async function matrix(t:import('node:test').TestContext,initial:CrashStore,
  operation:(s:CrashStore)=>Promise<unknown>,check:(s:CrashStore)=>Promise<void>){
  const baseline=initial.clone();await operation(baseline);const cuts=baseline.mutations,accessCuts=baseline.accesses;
  for(const mode of ['mutation','access'] as const)
  for(const when of (mode==='mutation'?['before','after']:['before']) as ('before'|'after')[])
  for(let cut=1;cut<=(mode==='mutation'?cuts:accessCuts);cut++){
    const s=initial.clone();s.cut=cut;s.when=when;s.mode=mode;
    try{await operation(s);}catch(error){assert.match(String(error),/PROCESS_CRASH/,`${when} mutation ${cut}`);}
    assert(s.crashed,`Fault not reached: ${when} ${cut}`);
    await check(s); // Reader state is verified even before the retry.
    await operation(s);await check(s);
    assert.equal(await s.read('base/matrix-base/release.json')===null,
      await baseline.read('base/matrix-base/release.json')===null);
    const original=await initial.read('base/matrix-base/release.json');
    if(original)assert.deepEqual(await s.read('base/matrix-base/release.json'),original);
  }
  t.diagnostic(`${cuts*2} before/after mutation cut points and ${accessCuts} failed-read/stat/list cut points verified`);
}

test('fault matrix: initialization, paired commit and finalization survive every durable mutation',async t=>{
  t.mock.method(console,'log',()=>{});const c=context(),initial=new CrashStore();
  await matrix(t,initial,async s=>{
    if(await reconcilePendingPublication(s))return;
    if(await s.read('active.json'))return;
    await s.write('work/context.json',encode(c),false);
    await prepareGeneration(s,c,'base',inputs(c,true));
    await commitGeneration(s,await prepareGeneration(s,c,'release',inputs(c)));
    await finalizePublishedRun(s,c);
  },async s=>{if(await s.read('active.json'))assert.equal((await preflight(s,'update',true))!.releaseId,c.releaseId);});
});

test('fault matrix: interrupted update and cleanup leave one complete NL/EU pair visible',async t=>{
  t.mock.method(console,'log',()=>{});const {store,c}=await initialized(),next=context(c.releaseId);
  const checkpoint=Buffer.from('checkpoint required by the attempt');
  await matrix(t,store,async s=>{
    if(await reconcilePendingPublication(s))return;
    if((await preflight(s,'update'))!.releaseId===next.releaseId)return;
    await s.write('work/context.json',encode(next),false);
    await saveCheckpoint(s,next,'release',new Map([['NL/state.json',checkpoint]]),'NL');
    await commitGeneration(s,await prepareGeneration(s,next,'release',inputs(next)));
    await finalizePublishedRun(s,next);
  },async s=>{assert([c.releaseId,next.releaseId].includes((await preflight(s,'update',true))!.releaseId));});
});

test('fault matrix: checkpoint publication preserves either old or fully verified new bytes',async t=>{
  t.mock.method(console,'log',()=>{});const {store,c}=await initialized();
  await saveCheckpoint(store,c,'release',new Map([['NL/state.json',Buffer.from('old')]]),'NL');
  await matrix(t,store,s=>saveCheckpoint(s,c,'release',new Map([['NL/state.json',Buffer.from('new')]]),'NL'),async s=>{
    assert(['old','new'].includes((await loadCheckpoint(s,c,'NL','release'))!.files.get('NL/state.json')!.toString()));
    assert.equal((await preflight(s,'update',true))!.releaseId,c.releaseId);
  });
});

test('fault matrix: interrupted checkpoint reads preserve the durable index and active pair',async t=>{
  t.mock.method(console,'log',()=>{});const {store,c}=await initialized();
  await saveCheckpoint(store,c,'release',new Map([['NL/state.json',Buffer.from('verified checkpoint')]]),'NL');
  const index=await store.read('work/checkpoint-NL.json');
  await matrix(t,store,s=>loadCheckpoint(s,c,'NL','release'),async s=>{
    assert.deepEqual(await s.read('work/checkpoint-NL.json'),index);
    assert.equal((await preflight(s,'update',true))!.releaseId,c.releaseId);
  });
});

test('fault matrix: rollback retry preserves its operation and retires superseded work',async t=>{
  t.mock.method(console,'log',()=>{});const {store,c}=await initialized(),next=context(c.releaseId);
  await commitGeneration(store,await prepareGeneration(store,next,'release',inputs(next)));
  await store.write('work/context.json',encode(next),false);
  await matrix(t,store,async s=>{
    const active=(await preflight(s,'update',true))!;
    await rollbackGeneration(s,c.releaseId,active.releaseId);
  },async s=>{assert([c.releaseId,next.releaseId].includes((await preflight(s,'update',true))!.releaseId));});
});

test('fault matrix: explicit corrupt-pointer recovery resumes every durable write and removal',async t=>{
  t.mock.method(console,'log',()=>{});const {store,c}=await initialized();
  await store.write('work/context.json',encode(c),false);
  const corrupt=Buffer.from('{corrupt');await store.write('active.json',corrupt,false);
  await matrix(t,store,s=>recoverGeneration(s,c.releaseId,hash(corrupt)),async s=>{
    const bytes=(await s.read('active.json'))!;
    if(!bytes.equals(corrupt))assert.equal((await preflight(s,'update',true))!.releaseId,c.releaseId);
  });
});

test('fault matrix: retention and history cleanup never remove active, backups, base or checkpoint',async t=>{
  t.mock.method(console,'log',()=>{});const {store,c}=await initialized();let parent=c.releaseId;
  for(let i=0;i<4;i++){const next=context(parent);
    await commitGeneration(store,await prepareGeneration(store,next,'release',inputs(next)));parent=next.releaseId;}
  const activeId=parent;
  await saveCheckpoint(store,c,'release',new Map([['NL/state.json',Buffer.from('protected checkpoint')]]),'NL');
  await matrix(t,store,s=>retainReleases(s,new Date('2099-01-01T00:00:00.000Z')),async s=>{
    assert.equal((await preflight(s,'update',true))!.releaseId,activeId);
    assert.equal((await loadCheckpoint(s,c,'NL','release'))!.files.get('NL/state.json')!.toString(),'protected checkpoint');
    assert(await s.read(`releases/${c.releaseId}/release.json`));
  });
});
