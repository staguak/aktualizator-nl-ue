import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {completedBuild,materializeCompletedOutputs} from './completed-build.js';
import type {PublicationInputs} from './completed-build.js';
import {prepareGeneration,newContext,commitGeneration,validateContext,saveCheckpoint,loadCheckpoint} from './release-engine.js';
import type {RunContext} from './release-engine.js';
import {finalizePublishedRun} from './release-lifecycle.js';
import {buildReport} from './build-report.js';
import {operationMetrics,OperationMetrics} from './operation-metrics.js';
import {encode,hash} from './release-store.js';
import type {ReleaseStore} from './release-store.js';

class Store implements ReleaseStore {
  files=new Map<string,Buffer>();trace:{method:string;key:string}[]=[];fault=0;after=false;armed=false;
  enter(method:string,key:string){this.trace.push({method,key});if(this.armed&&!this.after&&this.trace.length===this.fault)throw new Error('Injected transport failure');}
  leave(){if(this.armed&&this.after&&this.trace.length===this.fault)throw new Error('Injected transport failure');}
  metadata(key:string){const b=this.files.get(key);return b?{id:key,size:b.length,md5:hash(b,'md5'),sha256:hash(b)}:null;}
  async read(key:string){this.enter('read',key);const value=this.files.get(key)??null;this.leave();return value;}
  async stat(key:string){this.enter('stat',key);const value=this.metadata(key);this.leave();return value;}
  async list(key:string){this.enter('list',key);const value=[...this.files.keys()].filter(k=>k.startsWith(key));this.leave();return value;}
  async write(key:string,bytes:Buffer,immutable:boolean){
    this.enter('write',key);const old=this.files.get(key);if(old&&immutable&&!old.equals(bytes))throw new Error('Immutable conflict');
    this.files.set(key,Buffer.from(bytes));const value=this.metadata(key)!;this.leave();return value;
  }
  async remove(key:string){this.enter('remove',key);this.files.delete(key);this.leave();}
}
const context=()=>newContext({mode:'initialize',baseId:'technical-base',parentReleaseId:null,codeRevision:'a'.repeat(40),configSha256:'b'.repeat(64),
  rangeFrom:'2025-01-01',rangeTo:'2026-10-20',observedOn:'2026-10-21'});
test('durable NO_CHANGE skips full snapshot; changed input and interrupted source check remain safe',async()=>{
  for(const outcome of ['unchanged','changed','failure']){
    const store=new Store(),c=newContext({...context(),mode:'update',parentReleaseId:'previous-release'});
    let checks=0;
    const run=()=>completedBuild(store,c,'release',async()=>pair(c),()=>{},async()=>{
      checks++;if(outcome==='failure')throw new Error('source receipt failure');return outcome==='unchanged';
    });
    if(outcome==='failure')await assert.rejects(run(),/source receipt failure/);else await run();
    assert.equal(checks,1);
    assert.equal(store.files.has('work/checkpoint.json'),outcome==='changed');
    assert.equal(store.trace.some(t=>t.method==='write'&&t.key.startsWith('work/snapshots/')),outcome==='changed');
    assert.equal([...store.files.keys()].some(k=>k.startsWith('releases/')),false);
  }
});
// Explicit technical corpora exercise storage/report boundaries, not legal
// source acceptance. The actual buildReport measures the mocked process.
function pair(c:RunContext,base=false):PublicationInputs{
  return new Map((['NL','EU'] as const).map(jurisdiction=>{
    const m={jurisdiction,rangeFrom:c.rangeFrom,rangeTo:base?c.rangeFrom:c.rangeTo,officialSources:{observedOn:c.observedOn},acts:[]};
    const r=buildReport(m,null,{status:'PASS',checks:[],fileCount:0,contentFileCount:0,contentBytes:0},
      {LAW_RELEASE_CONTEXT:JSON.stringify(c),LAW_RELEASE_PHASE:base?'base':'release'});
    return [jurisdiction,new Map([['manifest.json',encode(m)],['INDEX.md',Buffer.from('explicit technical index')],['REPORT.md',Buffer.from('```json\n'+JSON.stringify(r)+'\n```\n')]])];
  }));
}
function validate(pair:PublicationInputs){
  assert.equal(pair.size,2);
  for(const module of ['NL','EU'] as const){
    assert.equal(JSON.parse(pair.get(module)!.get('manifest.json')!.toString()).jurisdiction,module);
    const report=JSON.parse(pair.get(module)!.get('REPORT.md')!.toString().split('```json\n')[1].split('\n```')[0]);
    assert.equal(report.validation.status,'PASS');
  }
}
test('partial generation retry preserves the original measured REPORT and skips both builders',async t=>{
  t.mock.method(console,'log',()=>{});let reuse=0;
  t.mock.method(operationMetrics,'snapshot',()=>{const m=new OperationMetrics();m.add('actsCheckpointReused',reuse);return m.snapshot();});
  const store=new Store(),c=context();await prepareGeneration(store,c,'base',pair(c,true));
  let builds=0,validations=0;const first=await completedBuild(store,c,'release',async()=>{builds++;return pair(c);},validate);
  const key=`releases/${c.releaseId}/NL/REPORT.md`;
  // Model a process interruption immediately after an immutable report write.
  await store.write(`releases/${c.releaseId}/preparation.json`,encode({schemaVersion:1,context:c}),true);
  await store.write(key,first.get('NL')!.get('REPORT.md')!,true);
  const original=store.files.get(key)!;reuse=1;assert.notDeepEqual(pair(c).get('NL')!.get('REPORT.md'),original);
  const restored=await completedBuild(store,c,'release',async()=>{builds++;return pair(c);},value=>{validations++;validate(value);});
  assert.equal(builds,1);assert.equal(validations,1);assert.deepEqual(restored.get('NL')!.get('REPORT.md'),original);
  await commitGeneration(store,await prepareGeneration(store,c,'release',restored));await finalizePublishedRun(store,c);
  assert.deepEqual(store.files.get(key),original);assert.equal((await store.list('work/')).length,0);
});
test('completed input freeze and partial preparation survive every observed before/after store failure without contradictory bytes',async t=>{
  t.mock.method(console,'log',()=>{});let reuse=0;
  t.mock.method(operationMetrics,'snapshot',()=>{const m=new OperationMetrics();m.add('actsCheckpointReused',reuse);return m.snapshot();});
  const run=async(store:Store,c:RunContext,build:()=>Promise<PublicationInputs>)=>{
    const candidate=await completedBuild(store,c,'release',build,validate);
    await prepareGeneration(store,c,'release',candidate);return candidate;
  };
  const control=new Store(),controlContext=context();await run(control,controlContext,async()=>pair(controlContext));const cuts=control.trace.length;assert(cuts>20);
  let checked=0;
  for(const after of [false,true])for(let cut=1;cut<=cuts;cut++){
    const store=new Store(),c=context();store.fault=cut;store.after=after;store.armed=true;reuse=0;
    await assert.rejects(run(store,c,async()=>pair(c)),/Injected transport failure/);store.armed=false;
    assert.equal(store.files.has('active.json'),false);const before=new Map([...store.files].filter(([k])=>k.startsWith(`releases/${c.releaseId}/`)));
    reuse=1;const restored=await run(store,c,async()=>pair(c));
    for(const [k,b] of before)assert.deepEqual(store.files.get(k),b,'Any immutable generation byte already stored must remain exact');
    for(const module of ['NL','EU'] as const)assert.deepEqual(store.files.get(`releases/${c.releaseId}/${module}/REPORT.md`),restored.get(module)!.get('REPORT.md'));
    assert.equal(store.files.has('active.json'),false);checked++;
  }
  assert.equal(checked,2*cuts);t.diagnostic(JSON.stringify({completedBuildFaultCuts:{operations:cuts,before:cuts,after:cuts,checked}}));
});
test('every read failure during completed snapshot restore remains retryable without writes, rebuilds or loss of the original report',async t=>{
  t.mock.method(console,'log',()=>{});const seed=new Store(),c=context();
  const original=await completedBuild(seed,c,'release',async()=>pair(c),validate);
  const reportKey=`releases/${c.releaseId}/NL/REPORT.md`;await seed.write(reportKey,original.get('NL')!.get('REPORT.md')!,true);
  const control=new Store();control.files=new Map(seed.files);
  await completedBuild(control,c,'release',async()=>{throw new Error('Forbidden rebuild');},validate);
  const cuts=control.trace.length;assert(cuts>10);let checked=0;
  for(const after of [false,true])for(let cut=1;cut<=cuts;cut++){
    const store=new Store();store.files=new Map(seed.files);store.armed=true;store.fault=cut;store.after=after;const before=new Map(store.files);
    await assert.rejects(completedBuild(store,c,'release',async()=>{throw new Error('Forbidden rebuild');},validate),/Injected transport failure/);
    assert.deepEqual(store.files,before);store.armed=false;
    const restored=await completedBuild(store,c,'release',async()=>{throw new Error('Forbidden rebuild');},validate);
    await prepareGeneration(store,c,'release',restored);assert.deepEqual(store.files.get(reportKey),original.get('NL')!.get('REPORT.md'));checked++;
  }
  assert.equal(checked,2*cuts);t.diagnostic(JSON.stringify({completedBuildRestoreFaultCuts:{operations:cuts,before:cuts,after:cuts,checked}}));
});
test('a frozen build never falls back to rebuilding after corruption, validator failure, context change or transport error',async t=>{
  t.mock.method(console,'log',()=>{});
  for(const failure of ['payload','validation','context','transport']){
    const store=new Store(),c=context();await completedBuild(store,c,'release',async()=>pair(c),validate);
    const pointer=JSON.parse(store.files.get('work/checkpoint.json')!.toString());
    if(failure==='payload')store.files.set(pointer.objects[0].key,Buffer.from('corrupt payload'));
    const requested=failure==='context'?{...c,observedOn:'2026-10-20'}:c;
    if(failure==='transport')store.read=async()=>{throw new Error('Backend unavailable');};
    const before=new Map(store.files);let builds=0;
    await assert.rejects(completedBuild(store,requested,'release',async()=>{builds++;return pair(c);},()=>{if(failure==='validation')throw new Error('Validator rejected');}),
      /corruption|Validator rejected|context changed|Backend unavailable/);
    assert.equal(builds,0);assert.deepEqual(store.files,before);
  }
});
test('base and release snapshots, new operations and partial generations remain isolated',async t=>{
  t.mock.method(console,'log',()=>{});const store=new Store(),c=context();
  await completedBuild(store,c,'base',async()=>pair(c,true),validate);await prepareGeneration(store,c,'base',pair(c,true));
  let releaseBuilds=0;await completedBuild(store,c,'release',async()=>{releaseBuilds++;return pair(c);},validate);assert.equal(releaseBuilds,1);
  const later=newContext({...c,mode:'update',parentReleaseId:c.releaseId,parentOperationId:c.runId});validateContext(later);
  let laterBuilds=0;await completedBuild(store,later,'release',async()=>{laterBuilds++;return pair(later);},validate);assert.equal(laterBuilds,1);
  const partial=context();await store.write(`releases/${partial.releaseId}/preparation.json`,encode({schemaVersion:1,context:partial}),true);
  await assert.rejects(completedBuild(store,partial,'release',async()=>{throw new Error('Must not rebuild');},validate),/Partial generation/);
});
test('restored outputs preserve every exact buffer and refuse symlinks or unsafe names before clearing either module',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'completed-output-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const c=context(),inputs=pair(c);materializeCompletedOutputs(root,inputs);
  for(const module of ['NL','EU'] as const)for(const [name,bytes] of inputs.get(module)!)
    assert.deepEqual(fs.readFileSync(path.join(root,module==='NL'?'output':'output-ue',name)),bytes);
  const sentinel=path.join(root,'output/sentinel');fs.writeFileSync(sentinel,'keep');
  const outside=path.join(root,'evidence');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'preserved'),'original');
  fs.rmSync(path.join(root,'output-ue'),{recursive:true});fs.symlinkSync(outside,path.join(root,'output-ue'));
  assert.throws(()=>materializeCompletedOutputs(root,inputs),/Unsafe/);assert.equal(fs.readFileSync(sentinel,'utf8'),'keep');
  assert.equal(fs.readFileSync(path.join(outside,'preserved'),'utf8'),'original');
  fs.unlinkSync(path.join(root,'output-ue'));inputs.get('EU')!.set('../escape',Buffer.from('bad'));
  assert.throws(()=>materializeCompletedOutputs(root,inputs),/Unsafe/);assert.equal(fs.readFileSync(sentinel,'utf8'),'keep');
  assert.throws(()=>materializeCompletedOutputs(root,new Map([['NL',new Map()],['EU',new Map()]])),/controls/);
  assert.equal(fs.readFileSync(sentinel,'utf8'),'keep');
});
test('internally consistent but invalid snapshot profiles, foreign paths and oversized pointers cannot reach a rebuild or generation write',async t=>{
  t.mock.method(console,'log',()=>{});
  for(const kind of ['profile','missing-marker','foreign-path','missing-module','oversized-pointer'] as const){
    const store=new Store(),c=context();await completedBuild(store,c,'release',async()=>pair(c),validate);
    const snapshot=(await loadCheckpoint(store,c))!.files;
    if(kind==='profile'){const profile=JSON.parse(snapshot.get('build-profile.json')!.toString());profile.profile='unknown';snapshot.set('build-profile.json',encode(profile));}
    if(kind==='missing-marker')snapshot.delete('build-profile.json');
    if(kind==='foreign-path'||kind==='missing-module'){
      if(kind==='foreign-path')snapshot.set('OTHER/extra.bin',Buffer.from('foreign'));
      else for(const key of snapshot.keys())if(key.startsWith('EU/'))snapshot.delete(key);
      const profile=JSON.parse(snapshot.get('build-profile.json')!.toString());profile.files=snapshot.size-1;snapshot.set('build-profile.json',encode(profile));
    }
    await saveCheckpoint(store,c,'release',snapshot);
    if(kind==='oversized-pointer'){
      const stat=store.stat.bind(store);store.stat=async key=>{const meta=await stat(key);return key==='work/checkpoint.json'?{...meta!,size:9_000_000}:meta;};
    }
    const before=new Map(store.files);let builds=0;
    await assert.rejects(completedBuild(store,c,'release',async()=>{builds++;return pair(c);},validate),/profile|snapshot path|controls|pointer limit/);
    assert.equal(builds,0);assert.deepEqual(store.files,before);assert.equal((await store.list(`releases/${c.releaseId}/`)).length,0);
  }
});
