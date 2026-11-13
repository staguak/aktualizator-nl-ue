import test from 'node:test';
import assert from 'node:assert/strict';
import {OfficialSources} from './official-sources.js';
import {recordUnchangedSourceCheck,resumeSourceCheck,unchangedSourceEvidence} from './source-check.js';
import {commitGeneration,newContext,preflight,prepareGeneration} from './release-engine.js';
import {finalizePublishedRun} from './release-lifecycle.js';
import {buildReport} from './build-report.js';
import {nlIndex} from './nl-output.js';
import {euIndex} from './eu-output.js';
import {encode,hash} from './release-store.js';
import type {ReleaseStore,StoredObject} from './release-store.js';
import type {RunContext} from './release-engine.js';
import {completedBuild} from './completed-build.js';

class Store implements ReleaseStore {
  files=new Map<string,{bytes:Buffer;meta:StoredObject}>();serial=0;fail='';
  async read(key:string){return this.files.get(key)?.bytes??null;}
  async stat(key:string){return this.files.get(key)?.meta??null;}
  async list(prefix:string){return [...this.files.keys()].filter(k=>k.startsWith(prefix));}
  async remove(key:string){if(key===this.fail)throw new Error('interrupted cleanup');this.files.delete(key);}
  async write(key:string,bytes:Buffer,immutable:boolean){
    if(key===this.fail)throw new Error('interrupted receipt');const old=this.files.get(key);
    if(old&&immutable&&!old.bytes.equals(bytes))throw new Error('immutable conflict');
    const meta={id:old?.meta.id??String(++this.serial),size:bytes.length,sha256:hash(bytes),md5:hash(bytes,'md5')};
    this.files.set(key,{bytes:Buffer.from(bytes),meta});return meta;
  }
}
function pair(c:RunContext,options:{base?:boolean;changedBytes?:boolean;changedMetadata?:boolean;complete?:boolean;observed?:boolean;status?:200|304}={}){
  const end=options.base?c.rangeFrom:c.rangeTo;
  return new Map((['NL','EU'] as const).map(module=>{
    const id=module==='NL'?'BWBR0009616':'32016R0679',url=`https://official.example/${id}`;
    const source=new OfficialSources(module,id,{from:c.rangeFrom,to:end,observedOn:c.observedOn});
    if(options.complete!==false)source.completeDiscovery({protocol:module==='NL'?'SRU-2.0':'CELLAR-SPARQL',fixture:true});
    source.add('source.xml',{bytes:Buffer.from(options.changedBytes?'<source>corrected</source>':'<source>official</source>'),url,contentType:'application/xml',
      ...options.observed===false?{}:{observation:{retrievedAt:null,checkedAt:new Date().toISOString(),status:options.status??304,method:options.status===200?'downloaded' as const:'conditional-not-modified' as const}}},
      url,module==='NL'?'BWB-Toestand':'CELLAR-RDF-tree',{relation:options.changedMetadata?'changed':'original'});
    const archive=source.build(`01_${id}.sources.zip`);
    const manifest={jurisdiction:module,rangeFrom:c.rangeFrom,rangeTo:end,generatedAt:new Date().toISOString(),
      officialSources:{observedOn:c.observedOn,originalBytes:true},language:module==='EU'?'EN':undefined,
      acts:[{order:1,title:id,selectedArticles:[],files:[],[module==='NL'?'bwbId':'celex']:id,sourceArchive:archive.metadata}]};
    const report=buildReport(manifest,null,{status:'PASS',checks:[],fileCount:0,contentFileCount:0,contentBytes:0},{LAW_RELEASE_CONTEXT:JSON.stringify(c),LAW_RELEASE_PHASE:options.base?'base':'release'});
    return [module,new Map([['manifest.json',encode(manifest)],['INDEX.md',Buffer.from(module==='NL'?nlIndex(manifest as any):euIndex(manifest))],
      ['REPORT.md',Buffer.from('PASS\n\n```json\n'+JSON.stringify(report)+'\n```\n')],['content.md',Buffer.from('unchanged legal text')],[archive.metadata.name,archive.bytes]])];
  }));
}
async function fixture(){
  const store=new Store(),c=newContext({baseId:'test-base',parentReleaseId:null,mode:'initialize',codeRevision:'same-code',
    configSha256:'a'.repeat(64),rangeFrom:'2025-01-01',rangeTo:'2026-10-17',observedOn:'2026-10-17'});
  await prepareGeneration(store,c,'base',pair(c,{base:true,status:200}));
  await commitGeneration(store,await prepareGeneration(store,c,'release',pair(c,{status:200})));
  await finalizePublishedRun(store,c);
  const context=newContext({...c,mode:'update',parentReleaseId:c.releaseId,parentOperationId:c.runId});
  await store.write('work/context.json',encode(context),false);
  return {store,c,context};
}

test('complete same-range source check records evidence and preserves the exact active pointer',async t=>{
  t.mock.method(console,'log',()=>{});const {store,context}=await fixture(),pointer=await store.read('active.json');
  const candidate=await completedBuild(store,context,'release',async()=>pair(context),()=>{});
  assert(await store.read('work/checkpoint.json'));
  assert(await recordUnchangedSourceCheck(store,context,candidate));
  assert.deepEqual(await store.read('active.json'),pointer);
  assert.equal((await store.list('work/')).length,0,'NO_CHANGE finalization must also retire its completed input snapshot');
  const record=JSON.parse((await store.read(`checks/sources/${context.runId}.json`))!.toString());
  assert.equal(record.status,'NO_CHANGE');assert.equal(record.checkedThrough,context.rangeTo);assert.equal(record.evidence.length,2);
  assert.equal(record.indexComparisons.length,2);
  assert(record.indexComparisons.every((r:any)=>r.previousSha256!==r.currentSha256));
  assert.equal((await store.list('work/')).length,0);assert.equal(await resumeSourceCheck(store),null);
});
test('same legal text cannot hide source correction, metadata change, incomplete discovery or stale observations',async t=>{
  t.mock.method(console,'log',()=>{});
  for(const options of [{changedBytes:true},{changedMetadata:true},{complete:false},{observed:false}]){
    const {store,context}=await fixture();
    assert.equal(await unchangedSourceEvidence(store,context,pair(context,options)),null);
    assert.equal((await store.list('checks/sources/')).length,0);assert(await store.read('work/context.json'));
  }
  const {store,context}=await fixture(),candidate=pair(context);
  const [,archive]=[...candidate.get('NL')!].find(([name])=>name.endsWith('.zip'))!;
  assert(archive.length>0);
  const future={...context,createdAt:new Date(Date.now()+60_000).toISOString()};
  assert.equal(await unchangedSourceEvidence(store,future,candidate),null);
});
test('range extension and parser/config revision changes require a generation even with identical text',async t=>{
  t.mock.method(console,'log',()=>{});const {store,context}=await fixture();
  for(const changes of [{rangeTo:'2026-10-18',observedOn:'2026-10-18'},
    {codeRevision:'new-parser'},{configSha256:'b'.repeat(64)},{parentOperationId:'other-operation'}]){
    const next={...context,...changes};assert.equal(await unchangedSourceEvidence(store,next,pair(next)),null);
  }
});
test('no-change receipt and cleanup resume after interruption without advancing active or losing evidence',async t=>{
  t.mock.method(console,'log',()=>{});
  for(const stage of ['receipt','cleanup']){
    const {store,context}=await fixture(),pointer=await store.read('active.json');
    store.fail=stage==='receipt'?`checks/sources/${context.runId}.json`:'work/context.json';
    await assert.rejects(recordUnchangedSourceCheck(store,context,pair(context)),/interrupted/);
    assert(await store.read('work/source-check.json'));assert.deepEqual(await store.read('active.json'),pointer);
    store.fail='';assert((await resumeSourceCheck(store))?.runId===context.runId);
    assert.equal((await store.list('work/')).length,0);assert.deepEqual(await store.read('active.json'),pointer);
    assert.equal((await store.list('checks/sources/')).length,1);
  }
});
test('changed predecessor or later context cannot be deleted by an old no-change cleanup',async t=>{
  t.mock.method(console,'log',()=>{});
  for(const changed of ['pointer','context']){
    const {store,context}=await fixture();store.fail=`checks/sources/${context.runId}.json`;
    await assert.rejects(recordUnchangedSourceCheck(store,context,pair(context)));store.fail='';
    if(changed==='context')await store.write('work/context.json',encode({...context,runId:'later-work'}),false);
    else {const pointer=JSON.parse((await store.read('active.json'))!.toString());pointer.operationId='another-operation';await store.write('active.json',encode(pointer),false);}
    const before=await store.read('work/context.json');
    await assert.rejects(resumeSourceCheck(store),/later work|predecessor changed/);
    assert.deepEqual(await store.read('work/context.json'),before);assert(await store.read('work/source-check.json'));
    assert(await preflight(store,'update',true));
  }
});

test('every no-change storage boundary resumes without changing the published pair',async t=>{
  t.mock.method(console,'log',()=>{});
  const {store:baseline,context}=await fixture(),candidate=pair(context);
  const baselinePointer=await baseline.read('active.json');
  const counts:Record<string,number>={};
  for(const category of ['mutation','observation'] as const){
    const operations=category==='mutation'?['write','remove']:['read','stat','list'];
    function instrument(cut:number,after:boolean){
      const store=new Store();store.serial=baseline.serial;
      for(const [key,value] of baseline.files)store.files.set(key,{bytes:Buffer.from(value.bytes),meta:{...value.meta}});
      let accesses=0,enabled=true;
      for(const method of operations){
        const original=(store as any)[method].bind(store);
        (store as any)[method]=async(...args:any[])=>{
          const index=enabled?++accesses:0;
          if(enabled&&index===cut&&!after)throw new Error('injected source-check interruption');
          const result=await original(...args);
          if(enabled&&index===cut&&after)throw new Error('injected source-check interruption');
          return result;
        };
      }
      return {store,disable:()=>{enabled=false;},count:()=>accesses};
    }
    const complete=instrument(0,false);assert(await recordUnchangedSourceCheck(complete.store,context,candidate));
    const boundaries=complete.count();counts[category]=boundaries*2;
    for(let cut=1;cut<=boundaries;cut++)for(const after of [false,true]){
      const trial=instrument(cut,after);
      await assert.rejects(recordUnchangedSourceCheck(trial.store,context,candidate),/injected source-check interruption/);
      trial.disable();
      assert.deepEqual(await trial.store.read('active.json'),baselinePointer);
      assert(await preflight(trial.store,'update',true));
      if(await trial.store.read('work/source-check.json'))await resumeSourceCheck(trial.store);
      else if(!await trial.store.read(`checks/sources/${context.runId}.json`))
        assert(await recordUnchangedSourceCheck(trial.store,context,candidate));
      assert.deepEqual(await trial.store.read('active.json'),baselinePointer);
      assert.equal((await trial.store.list('checks/sources/')).length,1);
      assert.equal((await trial.store.list('work/')).length,0);
    }
  }
  t.diagnostic(JSON.stringify({sourceCheckFaultPoints:counts}));
});

test('index normalization verifies the complete generated index and never hides broken navigation or a false checksum',async t=>{
  t.mock.method(console,'log',()=>{});
  for(const change of ['checksum','navigation','extra-line']){
    const {store,context}=await fixture(),candidate=pair(context),module=candidate.get('NL')!;
    const index=module.get('INDEX.md')!.toString();
    module.set('INDEX.md',Buffer.from(change==='checksum'?index.replace(/MD5 [a-f0-9]{32}/,'MD5 '+('f'.repeat(32))):
      change==='navigation'?index.replace('Oryginalne źródła','Changed source link label'):index+'Unexpected new link\n'));
    const before=await store.read('active.json');
    await assert.rejects(unchangedSourceEvidence(store,context,candidate),/INDEX differs/);
    assert.deepEqual(await store.read('active.json'),before);assert.equal((await store.list('checks/sources/')).length,0);
  }
});

test('no-change checks prune operational history without sweeping or rotating corpus generations',async t=>{
  t.mock.method(console,'log',()=>{});
  const {store,context}=await fixture();
  const protectedBytes=new Map([...store.files].filter(([key])=>key.startsWith('base/')||key.startsWith('releases/'))
    .map(([key,value])=>[key,Buffer.from(value.bytes)]));
  const retentionBefore=await store.list('checks/retention/');
  await store.write('checks/sources/expired-check.json',encode({completedAt:'2020-01-01T00:00:00.000Z'}),true);
  const list=store.list.bind(store);
  store.list=async prefix=>{
    if(prefix==='releases/')throw new Error('A no-change check must not sweep generations');
    return list(prefix);
  };
  assert(await recordUnchangedSourceCheck(store,context,pair(context)));
  assert.equal(await store.read('checks/sources/expired-check.json'),null);
  assert.deepEqual(await store.list('checks/retention/'),retentionBefore);
  for(const [key,bytes] of protectedBytes)assert.deepEqual(await store.read(key),bytes);
  assert(await store.read(`checks/sources/${context.runId}.json`));
});
