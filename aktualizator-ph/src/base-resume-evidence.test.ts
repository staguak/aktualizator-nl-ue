import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyBaseResumeEvidence} from './base-resume-evidence.js';
import {baseCheckpointReadiness} from './base-checkpoint-readiness.js';
import {planningPart} from './release-planning.js';
import {commitGeneration,newContext,prepareGeneration} from './release-engine.js';
import type {RunContext} from './release-engine.js';
import {finalizePublishedRun} from './release-lifecycle.js';
import {buildReport} from './build-report.js';
import {encode,hash} from './release-store.js';
import type {ReleaseStore} from './release-store.js';
class Store implements ReleaseStore {
  files=new Map<string,Buffer>();
  async read(key:string){return this.files.get(key)??null;}
  async stat(key:string){const bytes=this.files.get(key);return bytes?{id:key,size:bytes.length,md5:hash(bytes,'md5'),sha256:hash(bytes)}:null;}
  async list(prefix:string){return [...this.files.keys()].filter(key=>key.startsWith(prefix));}
  async write(key:string,bytes:Buffer,immutable:boolean){const old=this.files.get(key);if(old&&immutable&&!old.equals(bytes))throw new Error('Immutable conflict');this.files.set(key,bytes);return (await this.stat(key))!;}
  async remove(key:string){this.files.delete(key);}
}
function pair(context:RunContext,base=false){
  return new Map((['NL','EU'] as const).map(jurisdiction=>{
    const manifest={jurisdiction,rangeFrom:context.rangeFrom,rangeTo:base?context.rangeFrom:context.rangeTo,
      officialSources:{observedOn:context.observedOn},acts:Array.from({length:jurisdiction==='NL'?2:63},(_,i)=>({[jurisdiction==='NL'?'bwbId':'celex']:`technical-${jurisdiction}-${i}`}))};
    const report=buildReport(manifest,null,{status:'PASS',checks:[],fileCount:0,contentFileCount:0,contentBytes:0},{LAW_RELEASE_CONTEXT:JSON.stringify(context),LAW_RELEASE_PHASE:base?'base':'release'});
    return [jurisdiction,new Map([['manifest.json',encode(manifest)],['INDEX.md',Buffer.from('technical index')],['REPORT.md',Buffer.from('```json\n'+JSON.stringify(report)+'\n```\n')]])];
  }));
}
test('base checkpoint evidence remains anchored to its producer after a later update, and cannot accept missing acts or altered dates',async t=>{
  t.mock.method(console,'log',()=>{});const store=new Store(),context=newContext({mode:'initialize',parentReleaseId:null,baseId:'base',codeRevision:'a'.repeat(40),configSha256:'b'.repeat(64),
    rangeFrom:'2025-01-01',rangeTo:'2026-10-20',observedOn:'2026-10-21'});
  await prepareGeneration(store,context,'base',pair(context,true));await commitGeneration(store,await prepareGeneration(store,context,'release',pair(context)));await finalizePublishedRun(store,context);
  const receipts=['NL','EU'].map(module=>({schemaVersion:1,context,module,phase:'base',completedActIds:Array.from({length:module==='NL'?2:63},(_,i)=>`technical-${module}-${i}`)}));
  for(const event of receipts)await store.write(`checks/resumes/${event.module}.json`,encode(event),true);
  const inspect=()=>verifyBaseResumeEvidence(store,context.codeRevision,context.configSha256);
  assert.deepEqual((await inspect()).restored,{NL:2,EU:63});
  assert.equal((await baseCheckpointReadiness(store,context.codeRevision,context.configSha256)).status,'READY');
  const later=newContext({...context,mode:'update',parentReleaseId:context.releaseId,parentOperationId:context.runId});
  await commitGeneration(store,await prepareGeneration(store,later,'release',pair(later)));await finalizePublishedRun(store,later);
  assert.equal((await inspect()).baseOperationId,context.runId);
  const readiness=await baseCheckpointReadiness(store,context.codeRevision,context.configSha256);
  assert('baseOperationId' in readiness);assert.equal(readiness.baseOperationId,context.runId);
  const eu=store.files.get('checks/resumes/EU.json')!,snapshot=new Map(store.files);
  const incomplete=structuredClone(receipts[1]);incomplete.completedActIds.pop();store.files.set('checks/resumes/EU.json',encode(incomplete));
  await assert.rejects(inspect(),/complete EU/);
  await assert.rejects(baseCheckpointReadiness(store,context.codeRevision,context.configSha256),/complete EU/);
  store.files.set('checks/resumes/EU.json',eu);
  const wrongDate=structuredClone(receipts[1]);wrongDate.context={...context,observedOn:'2026-10-20'};store.files.set('checks/resumes/EU.json',encode(wrongDate));
  await assert.rejects(inspect(),/context mismatch/);store.files.set('checks/resumes/EU.json',eu);
  await assert.rejects(verifyBaseResumeEvidence(store,'c'.repeat(40),context.configSha256),/another baseline/);
  assert.deepEqual(store.files,snapshot,'Inspection must never mutate backend evidence');
});
test('prepared immutable base preserves actual reuse proof when a later release-phase build is interrupted before first active',async t=>{
  t.mock.method(console,'log',()=>{});
  for(const planningRetained of [true,false]){
  const store=new Store(),context=newContext({mode:'initialize',parentReleaseId:null,baseId:'prepared-base',
    codeRevision:'a'.repeat(40),configSha256:'b'.repeat(64),rangeFrom:'2025-01-01',rangeTo:'2026-10-20',observedOn:'2026-10-21'});
  if(planningRetained)await planningPart(store,context,'combined-plan','NL-EU',async()=>({
    value:{scopes:Object.fromEntries([...pair(context,true)].map(([module,files])=>[module,JSON.parse(files.get('manifest.json')!.toString())]))},
    archives:new Map([['technical.sources.zip',Buffer.from('explicit technical retained planning evidence')]])}));
  await prepareGeneration(store,context,'base',pair(context,true));await store.write('work/context.json',encode(context),false);
  for(const module of ['NL','EU']){
    await store.write(`work/checkpoint-${module}.json`,encode({schemaVersion:1,context,phase:'release',objects:[]}),false);
    await store.write(`checks/resumes/${module}.json`,encode({schemaVersion:1,context,module,phase:'base',
      completedActIds:Array.from({length:module==='NL'?2:63},(_,i)=>`technical-${module}-${i}`)}),true);
  }
  const before=new Map(store.files),inspect=()=>baseCheckpointReadiness(store,context.codeRevision,context.configSha256);
  const result=await inspect();assert.equal(result.status,'READY');assert.equal(result.phase,'PREPARED_BASELINE_PROOF');
  assert('restored' in result);assert.deepEqual(result.restored,{NL:2,EU:63});
  assert.deepEqual(store.files,before,'Readiness must not touch a partially built release or the immutable base');
  const key='checks/resumes/EU.json',receipt=JSON.parse(store.files.get(key)!.toString());receipt.completedActIds.pop();store.files.set(key,encode(receipt));
  await assert.rejects(inspect(),/complete EU/);store.files.set(key,before.get(key)!);
  store.files.set('work/context.json',encode({...context,runId:'another-operation'}));await assert.rejects(inspect(),/Prepared baseline/);
  }
});
