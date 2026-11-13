import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DerivedCache} from './derived-cache.js';
import {hash} from './release-store.js';
import {parseBwbXml} from './bwb-parser.js';
import {buildNlModel} from './nl-model.js';

test('derived cache reuses exact inputs and invalidates corrected older bytes and parser/validation dependencies',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'derived-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const cache=new DerivedCache(dir),validate=(value:unknown):value is {text:string}=>typeof (value as any)?.text==='string';
  const dependencies={sourceSha256:hash(Buffer.from('old source')),parser:'one',profile:'XSD-one',language:'EN',include:'full-document',url:'https://official.example/one'};
  let calls=0;const compute=()=>{calls++;return {text:'computed '+calls};};
  assert.deepEqual(cache.value(dependencies,compute,validate),cache.value(dependencies,compute,validate));assert.equal(calls,1);
  for(const changes of [{sourceSha256:hash(Buffer.from('retroactive correction'))},{parser:'two'},
    {profile:'XSD-two'},{language:'NL'},{include:'operative-part'},{url:'https://official.example/two'}])
    cache.value({...dependencies,...changes},compute,validate);
  assert.equal(calls,7);assert.deepEqual(cache.stats,{hits:1,computed:7});
});
test('corrupt, partial, symlinked or structurally invalid derived outputs recompute safely',t=>{
  for(const scenario of ['checksum','partial','symlink','shape']){
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'derived-bad-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
    const cache=new DerivedCache(dir),dependencies={input:'official'},validate=(v:unknown):v is string=>typeof v==='string';
    cache.value(dependencies,()=> 'verified',validate);const file=path.join(dir,fs.readdirSync(dir)[0]);
    if(scenario==='partial')fs.writeFileSync(file,'{');
    else if(scenario==='symlink'){const original=file+'.outside';fs.renameSync(file,original);fs.symlinkSync(original,file);}
    else {const saved=JSON.parse(fs.readFileSync(file,'utf8'));saved.value=scenario==='shape'?{}:'corrupt';
      if(scenario==='shape')saved.valueSha256=hash(Buffer.from(JSON.stringify(saved.value,null,2)+'\n'));
      fs.writeFileSync(file,JSON.stringify(saved));}
    assert.equal(cache.value(dependencies,()=> 'recomputed',validate),'recomputed');assert.equal(cache.stats.computed,2);
  }
});
test('a symlinked cache ancestor cannot supply parser results or receive cache writes',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'derived-parent-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const outside=path.join(root,'outside'),link=path.join(root,'link'),dependencies={input:'official'};
  const validate=(value:unknown):value is string=>typeof value==='string';
  new DerivedCache(path.join(outside,'cache')).value(dependencies,()=> 'redirected cache result',validate);
  fs.writeFileSync(path.join(outside,'witness'),'preserve');
  const cacheFile=path.join(outside,'cache',fs.readdirSync(path.join(outside,'cache'))[0]),before=fs.readFileSync(cacheFile);
  fs.symlinkSync(outside,link,'dir');
  const cache=new DerivedCache(path.join(link,'cache'));
  assert.equal(cache.value(dependencies,()=> 'verified fresh parse',validate),'verified fresh parse');
  assert.deepEqual(cache.stats,{hits:0,computed:1});assert.deepEqual(fs.readFileSync(cacheFile),before);
  assert.equal(new DerivedCache(path.join(link,'new-cache')).value(dependencies,()=> 'computed',validate),'computed');
  assert(!fs.existsSync(path.join(outside,'new-cache')));assert.equal(fs.readFileSync(path.join(outside,'witness'),'utf8'),'preserve');
});
test('a cache directory replaced by a symlink during parsing remains optional and untouched',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'derived-replaced-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const dir=path.join(root,'cache'),outside=path.join(root,'outside');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'witness'),'preserve');
  const cache=new DerivedCache(dir);
  assert.equal(cache.value({input:'official'},()=>{fs.symlinkSync(outside,dir,'dir');return 'verified';},
    (value:unknown):value is string=>typeof value==='string'),'verified');
  assert.deepEqual(fs.readdirSync(outside),['witness']);assert.equal(fs.readFileSync(path.join(outside,'witness'),'utf8'),'preserve');
});
test('unchanged parsed bytes never hide changed documentary metadata or invent a unit legal date',()=>{
  const xml='<toestand bwb-id="BWBR0009616"><wetgeving><artikel><kop><label>Artikel</label><nr>1</nr></kop><al>Officiële tekst.</al></artikel></wetgeving></toestand>';
  const parsed=parseBwbXml(xml),cache=new DerivedCache(undefined);
  const statute=cache.value({source:hash(Buffer.from(xml))},()=>parsed,(v:unknown):v is typeof parsed=>!!v);
  const act={order:1,title:'Fixture',bwbId:'BWBR0009616',include:{articles:['1']},mustIncludeArticles:['1']};
  const model=(from:string)=>buildNlModel(act,[{statute,version:{key:from,toestandUrl:'https://official.example/state',validFrom:from,validTo:null}}],'2025-01-01','2026-10-17');
  const before=model('2025-01-01'),after=model('2025-02-01');
  assert.equal(before.states[0].contentHash,after.states[0].contentHash);
  assert.notDeepEqual(before.sourceStates,after.sourceStates);assert.notEqual(before.states[0].validFrom,after.states[0].validFrom);
  assert.equal(parsed.inForceDate,undefined);
});
test('optional cache cleanup denial preserves the computed value without certifying freshness',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'derived-cleanup-'));
  const remove=fs.rmSync.bind(fs);t.after(()=>remove(dir,{recursive:true,force:true}));
  t.mock.method(fs,'rmSync',(()=>{throw new Error('temporary cache cleanup denied');}) as typeof fs.rmSync);
  const cache=new DerivedCache(dir);
  assert.equal(cache.value({source:'already-validated'},()=> 'computed', (value:unknown):value is string=>typeof value==='string'),'computed');
  assert.deepEqual(cache.stats,{hits:0,computed:1});
  assert.equal(cache.value({source:'already-validated'},()=> 'not needed',(value:unknown):value is string=>typeof value==='string'),'computed');
  assert.deepEqual(cache.stats,{hits:1,computed:1});
});
