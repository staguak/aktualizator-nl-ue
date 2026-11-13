import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {measureStoreFootprint} from './store-footprint.js';
import {newContext,prepareGeneration,commitGeneration} from './release-engine.js';
import {encode,hash} from './release-store.js';
import type {ReleaseStore,StoredObject} from './release-store.js';

class Store implements ReleaseStore {
  files=new Map<string,Buffer>();
  async read(k:string){return this.files.get(k)??null;}
  async stat(k:string):Promise<StoredObject|null>{const b=this.files.get(k);return b?{id:k,size:b.length,md5:hash(b,'md5'),sha256:hash(b)}:null;}
  async write(k:string,b:Buffer,immutable:boolean){if(immutable&&this.files.has(k))assert.deepEqual(this.files.get(k),b);this.files.set(k,Buffer.from(b));return (await this.stat(k))!;}
  async list(p:string){return [...this.files.keys()].filter(k=>k.startsWith(p));}
  async remove(k:string){this.files.delete(k);}
}
async function fixture(){
  const store=new Store(),context=newContext({mode:'initialize',baseId:'base',parentReleaseId:null,codeRevision:'fixture',configSha256:'a'.repeat(64),rangeFrom:'2025-01-01',rangeTo:'2026-10-20',observedOn:'2026-10-20'});
  for(const kind of ['base','release'] as const){
    const inputs=new Map(['NL','EU'].map(j=>[j as 'NL'|'EU',new Map([
      ['manifest.json',encode({jurisdiction:j,rangeFrom:context.rangeFrom,rangeTo:kind==='base'?context.rangeFrom:context.rangeTo})],
      ['INDEX.md',Buffer.from('index')],['REPORT.md',Buffer.from('report')]])]));
    const p=await prepareGeneration(store,context,kind,inputs);if(kind==='release')await commitGeneration(store,p);
  }
  return store;
}
test('store footprint totals payload bytes independently, reads only and keeps work/checks in distinct areas',async t=>{
  t.mock.method(console,'log',()=>{});const store=await fixture();store.files.set('README.md',Buffer.from('reader'));
  const expected=[...store.files.values()].reduce((n,b)=>n+b.length,0),before=[...store.files].map(([k,b])=>[k,Buffer.from(b)]);
  store.write=async()=>{throw new Error('Forbidden write');};store.remove=async()=>{throw new Error('Forbidden removal');};
  const report=await measureStoreFootprint(store);
  assert.equal(report.totalBytes,expected);assert.equal(report.files,store.files.size);assert.equal(report.byArea.other.files,2);
  assert(report.byArea.work.bytes>0);assert(report.byArea.checks.bytes>0);assert.deepEqual([...store.files],before);
});
test('footprint rejects active, list and metadata races instead of certifying an inconsistent size',async t=>{
  t.mock.method(console,'log',()=>{});
  for(const mutation of ['metadata','inventory','active']){
    const store=await fixture(),stat=store.stat.bind(store),list=store.list.bind(store),read=store.read.bind(store);
    let rootLists=0,reads=0,stats=0;
    store.list=async prefix=>{const keys=await list(prefix);if(prefix===''&&++rootLists===2&&mutation==='inventory')keys.push('foreign');return keys;};
    store.stat=async key=>{const value=await stat(key);if(rootLists>0&&++stats>store.files.size&&mutation==='metadata'&&value)return {...value,size:value.size+1};return value;};
    store.read=async key=>{const value=await read(key);if(key==='active.json'&&++reads===2&&mutation==='active')return Buffer.from('{}');return value;};
    await assert.rejects(measureStoreFootprint(store),/changed/);
  }
});
test('footprint CLI rejects production or conflicting diagnostics before authenticating',()=>{
  const run=(namespace:string,args:string[])=>spawnSync(process.execPath,['--import','tsx','src/release-run.ts',...args],
    {env:{...process.env,LAW_RELEASE_NAMESPACE:namespace,GOOGLE_DRIVE_OAUTH_JSON:'not valid credentials'},encoding:'utf8'});
  const wrong=run('production',['--diagnose-footprint']);assert.equal(wrong.status,1);assert.match(wrong.stderr,/isolated test corpus/);
  const both=run('release-test-corpus-123-1',['--diagnose-footprint','--diagnose-base']);assert.equal(both.status,1);assert.match(both.stderr,/Choose one/);
});
