import test from 'node:test';
import assert from 'node:assert/strict';
import {commitGeneration,newContext,prepareGeneration,retainReleaseSweep} from './release-engine.js';
import {finalizePublishedRun} from './release-lifecycle.js';
import {publicationReport,verifyPublicationReport} from './publication-report.js';
import {buildReport} from './build-report.js';
import {encode,hash} from './release-store.js';
import type {ReleaseStore,StoredObject} from './release-store.js';
import type {RunContext} from './release-engine.js';
class Store implements ReleaseStore {
  files=new Map<string,Buffer>();fail='';missingReceipt=false;
  async read(key:string){return this.missingReceipt&&key.startsWith('checks/runs/')?null:this.files.get(key)??null;}
  async stat(key:string):Promise<StoredObject|null>{const b=this.files.get(key);return b?{id:key,size:b.length,md5:hash(b,'md5'),sha256:hash(b)}:null;}
  async list(prefix:string){return [...this.files.keys()].filter(k=>k.startsWith(prefix));}
  async write(key:string,b:Buffer,immutable:boolean){if(key===this.fail)throw new Error('interrupted write');const old=this.files.get(key);if(old&&immutable&&!old.equals(b))throw new Error('immutable conflict');this.files.set(key,Buffer.from(b));return (await this.stat(key))!;}
  async remove(key:string){if(key===this.fail)throw new Error('interrupted cleanup');this.files.delete(key);}
}
function pair(c:RunContext,base=false,mutation?:(build:any,jurisdiction:string)=>void){
  return new Map((['NL','EU'] as const).map(jurisdiction=>{
    const manifest={jurisdiction,rangeFrom:c.rangeFrom,rangeTo:base?c.rangeFrom:c.rangeTo,officialSources:{observedOn:c.observedOn},acts:[]};
    const report=buildReport(manifest,null,{status:'PASS',checks:[],fileCount:0,contentFileCount:0,contentBytes:0},{LAW_RELEASE_CONTEXT:JSON.stringify(c),LAW_RELEASE_PHASE:base?'base':'release'});
    mutation?.(report,jurisdiction);
    return [jurisdiction,new Map([['manifest.json',encode(manifest)],['INDEX.md',Buffer.from('INDEX')],['REPORT.md',Buffer.from('```json\n'+JSON.stringify(report)+'\n```\n')]])];
  }));
}
async function fixture(mutation?:(build:any,jurisdiction:string)=>void){
  const store=new Store(),context=newContext({mode:'initialize',parentReleaseId:null,baseId:'base',codeRevision:'fixture',configSha256:'a'.repeat(64),rangeFrom:'2025-01-01',rangeTo:'2026-10-20',observedOn:'2026-10-20'});
  await prepareGeneration(store,context,'base',pair(context,true));
  const prepared=await prepareGeneration(store,context,'release',pair(context,false,mutation));
  const active=await commitGeneration(store,prepared);return {store,context,active};
}
test('completion receipt joins exact immutable NL/EU build reports to actual commit and retention evidence',async t=>{
  t.mock.method(console,'log',()=>{});const {store,context,active}=await fixture();
  const reports=[...store.files].filter(([key])=>key.endsWith('/REPORT.md'));
  await finalizePublishedRun(store,context);
  const receipt=JSON.parse((await store.read(`checks/runs/${context.runId}.json`))!.toString());
  assert.equal(receipt.report.status,'COMMITTED_AND_RETENTION_VERIFIED');assert.equal(receipt.report.runId,context.runId);
  assert.deepEqual(receipt.report.moduleBuildReports.map((m:any)=>m.profile),['module-build-report-v1','module-build-report-v1']);
  const sweep=JSON.parse((await store.read(receipt.report.retention.key))!.toString());assert.equal(sweep.operationId,active.operationId);assert.equal(sweep.graceMs,72*3600*1000);
  await verifyPublicationReport(store,receipt.report,context,active);
  assert.deepEqual([...store.files].filter(([key])=>key.endsWith('/REPORT.md')),reports);
  assert.equal((await store.list('work/')).length,0);
});
test('wrong build context, failed validation and corrupt retention evidence keep publication journal intact',async t=>{
  t.mock.method(console,'log',()=>{});
  for(const mutate of [(b:any)=>{b.identity.releaseId='foreign';},(b:any)=>{b.validation.status='FAIL';},(b:any)=>{b.range.to='2026-10-19';}]){
    const {store,context,active}=await fixture(mutate);await assert.rejects(finalizePublishedRun(store,context),/context\/validation mismatch/);
    assert(await store.read('work/publication.json'));assert.equal(JSON.parse((await store.read('active.json'))!.toString()).releaseId,active.releaseId);
  }
  const {store,context,active}=await fixture(),sweep=await retainReleaseSweep(store);
  store.files.set(sweep.evidence.key,Buffer.from('{}'));await assert.rejects(publicationReport(store,context,active,sweep.evidence),/corrupted/);
});
test('cleanup retry keeps the original report and its referenced sweep even beyond normal retention horizon',async t=>{
  t.mock.method(console,'log',()=>{});const {store,context}=await fixture();await store.write('work/context.json',encode(context),false);
  store.fail='work/context.json';await assert.rejects(finalizePublishedRun(store,context),/interrupted cleanup/);
  const key=`checks/runs/${context.runId}.json`,before=Buffer.from((await store.read(key))!),receipt=JSON.parse(before.toString());
  await retainReleaseSweep(store,new Date('2099-01-01T00:00:00Z'));
  assert(await store.read(receipt.report.retention.key));assert(await store.read(key));
  store.fail='';await finalizePublishedRun(store,context);assert.deepEqual(await store.read(key),before);
});
test('missing completion evidence after a successful write blocks cleanup; retry checks the persisted record',async t=>{
  t.mock.method(console,'log',()=>{});const {store,context}=await fixture();store.missingReceipt=true;
  await assert.rejects(finalizePublishedRun(store,context),/missing run completion/);assert(await store.read('work/publication.json'));
  store.missingReceipt=false;await finalizePublishedRun(store,context);assert.equal((await store.list('work/')).length,0);
});
test('completion references cannot bypass root anchors or admit duplicate/foreign partners',async t=>{
  t.mock.method(console,'log',()=>{});const {store,context,active}=await fixture(),sweep=await retainReleaseSweep(store),report=await publicationReport(store,context,active,sweep.evidence);
  for(const mutate of [(r:any)=>{r.moduleBuildReports[0].sha256='a'.repeat(64);},(r:any)=>{r.moduleBuildReports[1]=r.moduleBuildReports[0];},(r:any)=>{r.retention.key='../../escape';},(r:any)=>{r.baseId='foreign';}]){
    const copy=structuredClone(report);mutate(copy);await assert.rejects(verifyPublicationReport(store,copy,context,active));
  }
});

test('an old finalizer cannot delete the next operation while the same release remains active',async t=>{
  t.mock.method(console,'log',()=>{});const {store,context}=await fixture();
  await finalizePublishedRun(store,context);
  const next=newContext({...context,mode:'update',parentReleaseId:context.releaseId,parentOperationId:context.runId});
  await store.write('work/context.json',encode(next),false);await store.write('work/new-checkpoint.bin',Buffer.from('new operation data'),true);
  const before=new Map([...store.files].map(([key,bytes])=>[key,Buffer.from(bytes)]));
  await assert.rejects(finalizePublishedRun(store,context),/later|different.*work|work.*context/i);
  assert.deepEqual(store.files,before);
});

test('a verified completion receipt resumes cleanup without another generation sweep',async t=>{
  t.mock.method(console,'log',()=>{});const {store,context}=await fixture();
  await store.write('work/context.json',encode(context),false);store.fail='work/context.json';
  await assert.rejects(finalizePublishedRun(store,context),/interrupted cleanup/);
  const sweeps=await store.list('checks/retention/'),list=store.list.bind(store);store.fail='';
  store.list=async prefix=>{if(prefix==='releases/')throw new Error('Duplicate generation sweep');return list(prefix);};
  await finalizePublishedRun(store,context);assert.deepEqual(await store.list('checks/retention/'),sweeps);
  assert.equal((await store.list('work/')).length,0);
});
