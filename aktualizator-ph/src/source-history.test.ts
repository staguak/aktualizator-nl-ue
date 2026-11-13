import test from 'node:test';
import assert from 'node:assert/strict';
import {OfficialSources} from './official-sources.js';
import {encode,hash} from './release-store.js';
import type {ReleaseStore,StoredObject} from './release-store.js';
import {commitGeneration,newContext,prepareGeneration,preflight,retainReleases} from './release-engine.js';
import {readSourceHistory,restoreHistoricalFile,preserveRetiredSources} from './source-history.js';

class MemoryStore implements ReleaseStore {
  objects=new Map<string,Buffer>();removed:string[]=[];failWrite='';lostWrite='';failDelete=false;
  async read(key:string){return this.objects.get(key)??null;}
  async stat(key:string):Promise<StoredObject|null>{const b=this.objects.get(key);return b?{id:key,size:b.length,md5:hash(b,'md5'),sha256:hash(b)}:null;}
  async write(key:string,bytes:Buffer,immutable:boolean){
    if(key.includes(this.failWrite)&&this.failWrite)throw new Error('Injected history write failure');
    const old=this.objects.get(key);if(old&&immutable&&!old.equals(bytes))throw new Error('Immutable conflict');this.objects.set(key,Buffer.from(bytes));
    if(key.includes(this.lostWrite)&&this.lostWrite){this.lostWrite='';throw new Error('Lost response after successful history write');}return (await this.stat(key))!;
  }
  async list(prefix:string){return [...this.objects.keys()].filter(k=>k.startsWith(prefix)).sort();}
  async remove(key:string){if(this.failDelete){this.failDelete=false;this.objects.delete(key);throw new Error('Interrupted retirement deletion');}this.removed.push(key);this.objects.delete(key);}
}
const future=new Date('2099-01-01T00:00:00Z');
function inputs(c:any,value:string,base=false){
  const a=new OfficialSources('NL','BWBR0000001',{from:c.rangeFrom,to:base?c.rangeFrom:c.rangeTo,observedOn:c.observedOn});
  a.add('state.xml',{bytes:Buffer.from(`<toestand bwb-id="BWBR0000001"><artikel>${value}</artikel></toestand>`),url:'https://example.org/state',contentType:'application/xml'},'https://example.org/state','BWB-Toestand');
  a.add('shared.xml',{bytes:Buffer.from('<wti>'+('Shared exact original bytes. '.repeat(4000))+'</wti>'),url:'https://example.org/shared',contentType:'application/xml'},'https://example.org/shared','BWB-WTI');
  const archive=a.build('01_BWBR0000001.sources.zip');
  return new Map((['NL','EU'] as const).map(j=>[j,new Map([
    ['manifest.json',encode({jurisdiction:j,rangeFrom:c.rangeFrom,rangeTo:base?c.rangeFrom:c.rangeTo,acts:j==='NL'?[{bwbId:a.identifier,sourceArchive:archive.metadata}]:[]})],
    ['INDEX.md',Buffer.from('index')],['REPORT.md',Buffer.from('PASS')],
    ...j==='NL'?[[archive.metadata.name,archive.bytes] as [string,Buffer]]:[],
  ])]));
}
async function fixture(){
  const store=new MemoryStore();let parent:string|null=null;const revisions=[];
  for(let i=0;i<5;i++){
    const c=newContext({baseId:'baseline',parentReleaseId:parent,mode:parent?'update':'initialize',codeRevision:'history-test',configSha256:'a'.repeat(64),rangeFrom:'2025-01-01',rangeTo:'2026-10-20',observedOn:'2026-10-20'});
    if(!parent)await prepareGeneration(store,c,'base',inputs(c,'BASE',true));
    const pair=inputs(c,i<2?'OLD-'+i:'CORRECTED');
    const prepared=await prepareGeneration(store,c,'release',pair),pointer=await commitGeneration(store,prepared);
    revisions.push({c,pointer,native:pair.get('NL')!.get('01_BWBR0000001.sources.zip')!});parent=c.releaseId;
  }
  return {store,revisions};
}
test('retention rotates three generations while preserving exact older source bytes, provenance and immutable base',async()=>{
  const {store,revisions}=await fixture(),active=Buffer.from((await store.read('active.json'))!),base=[...store.objects].filter(([k])=>k.startsWith('base/'));
  assert.equal((await retainReleases(store,future,0)).length,2);
  for(const old of revisions.slice(0,2)){
    const key=`releases/${old.c.releaseId}/NL/01_BWBR0000001.sources.zip`;
    assert.equal(await store.read(key),null);const history=await readSourceHistory(store,old.c.releaseId);assert(history);
    assert.deepEqual(await restoreHistoricalFile(store,history,key),old.native);
    assert.equal(history.pointer.manifestSha256,old.pointer.manifestSha256);
  }
  assert.equal(new Set((await store.list('releases/')).map(k=>k.split('/')[1])).size,3);
  assert.deepEqual(await store.read('active.json'),active);assert.deepEqual([...store.objects].filter(([k])=>k.startsWith('base/')),base);
  const records=await Promise.all(revisions.slice(0,2).map(r=>readSourceHistory(store,r.c.releaseId)));
  const sourceChunks=records.map(r=>r!.files.find(f=>f.encoding==='zip-byte-chunks')!.chunks);
  assert(sourceChunks[0].some(a=>sourceChunks[1].some(b=>a.sha256===b.sha256&&a.size>50)),'identical compressed source streams are physically shared');
  const all=records.flatMap(r=>r!.files.flatMap(f=>f.chunks));
  assert((await store.list('source-history/objects/')).length<all.length);
});
test('failed chunk or record persistence never starts retirement and retries safely after a lost write response',async()=>{
  for(const scenario of ['objects/','generations/','lost-record','lost-chunk']){
    const {store,revisions}=await fixture();if(scenario.startsWith('lost-'))store.lostWrite=scenario==='lost-record'?'generations/':'objects/';else store.failWrite=scenario;
    await assert.rejects(retainReleases(store,future,0),/history write|Lost response/);assert.equal(store.removed.length,0);
    store.failWrite='';assert.equal((await retainReleases(store,future,0)).length,2);
    assert(await readSourceHistory(store,revisions[0].c.releaseId));
  }
});
test('retirement interrupted after a successful deletion resumes from the verified durable historical record',async()=>{
  const {store,revisions}=await fixture();store.failDelete=true;
  await assert.rejects(retainReleases(store,future,0),/Interrupted retirement deletion/);
  const history=await readSourceHistory(store,revisions[0].c.releaseId);assert(history);
  assert.equal((await retainReleases(store,future,0)).length,2);
  assert.deepEqual(await restoreHistoricalFile(store,history,`releases/${revisions[0].c.releaseId}/NL/01_BWBR0000001.sources.zip`),revisions[0].native);
});
test('corrupt retired evidence or original source aborts before any further deletion',async()=>{
  for(const scenario of ['original','chunk','record']){
    const {store,revisions}=await fixture(),first=revisions[0];
    if(scenario==='original')store.objects.set(`releases/${first.c.releaseId}/NL/01_BWBR0000001.sources.zip`,Buffer.from('corrupt'));
    else{
      await preserveRetiredSources(store,first.pointer);
      const key=scenario==='chunk'?(await store.list('source-history/objects/'))[0]:`source-history/generations/${first.c.releaseId}.json`;
      store.objects.set(key,Buffer.from('corrupt'));
    }
    await assert.rejects(retainReleases(store,future,0));assert.equal(store.removed.length,0);
    assert.equal((await preflight(store,'update'))?.releaseId,revisions.at(-1)!.c.releaseId);
  }
});
test('history references reject tampering, duplicates and traversal without mutating active data',async()=>{
  const {store,revisions}=await fixture(),first=revisions[0];await preserveRetiredSources(store,first.pointer);
  const key=`source-history/generations/${first.c.releaseId}.json`,original=store.objects.get(key)!;
  for(const mutate of [(r:any)=>r.files.push(r.files[0]),(r:any)=>r.files[0].chunks[0].sha256='../escape',(r:any)=>r.pointer.manifestSha256='a'.repeat(64)]){
    const value=JSON.parse(original.toString());mutate(value);store.objects.set(key,encode(value));
    await assert.rejects(readSourceHistory(store,first.c.releaseId));
  }
  await assert.rejects(readSourceHistory(store,'../escape'),/Invalid historical release identity/);
});
